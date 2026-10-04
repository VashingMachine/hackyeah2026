import { z } from 'zod';
import type { ChatMessage, ChatRequest } from './chat.ts';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ResponseItem = Record<string, unknown>;
export type ReasoningContext = Map<string, ResponseItem[]>;

const textOf = (content: ChatMessage['content']) => typeof content === 'string' ? content :
  Array.isArray(content) ? content.map((p) => p.text ?? '').join('\n') : '';

/** Keep Pi's chat protocol, but use Responses so Luna can call tools with reasoning=low. */
export function toResponsesRequest(req: ChatRequest, model: string, maxOutput: number, effort: ReasoningEffort = 'low', reasoning: ReasoningContext = new Map()): Record<string, unknown> {
  const input: ResponseItem[] = [];
  for (const message of req.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textOf(message.content) });
      continue;
    }
    const content = textOf(message.content);
    if (content || !message.tool_calls?.length) input.push({ role: message.role, content });
    if (message.tool_calls?.length) {
      // Encrypted reasoning is server-owned and scoped to this session, never accepted from a client.
      const previous = reasoning.get(message.tool_calls[0]!.id);
      if (previous) input.push(...previous);
      for (const call of message.tool_calls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const tools = req.tools?.map((tool) => {
    const t = tool as { type: string; function: Record<string, unknown> };
    return { type: 'function', ...t.function, strict: t.function.strict ?? false };
  });
  const choice = req.tool_choice as { type?: string; function?: { name: string } } | string | undefined;
  const toolChoice = typeof choice === 'object' && choice?.type === 'function' ? { type: 'function', name: choice.function?.name } : choice;
  return {
    model, input, max_output_tokens: maxOutput, reasoning: { effort }, store: false,
    include: ['reasoning.encrypted_content'],
    ...(tools?.length ? { tools, ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}) } : {}),
    // Sampling controls are only supported when reasoning is disabled for current Luna models.
    ...(effort === 'none' && req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(effort === 'none' && req.top_p !== undefined ? { top_p: req.top_p } : {}),
  };
}

const tokenCount = z.number().int().nonnegative();
const ResponseSchema = z.object({
  id: z.string().min(1),
  created_at: z.number().optional(),
  status: z.enum(['completed', 'incomplete']),
  incomplete_details: z.object({ reason: z.string() }).nullable().optional(),
  output: z.array(z.record(z.string(), z.unknown())),
  usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount, total_tokens: tokenCount,
    input_tokens_details: z.object({ cached_tokens: tokenCount }).optional(),
    output_tokens_details: z.object({ reasoning_tokens: tokenCount }).optional(),
  }),
});

export function responsesToChat(body: unknown, model: string, reasoning: ReasoningContext = new Map()): Record<string, unknown> {
  const response = ResponseSchema.parse(body);
  const calls: NonNullable<ChatMessage['tool_calls']> = [];
  const texts: string[] = [];
  const reasoningItems = response.output.filter((item) => item.type === 'reasoning');
  for (const item of response.output) {
    if (item.type === 'function_call') {
      const call = z.object({ call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }).parse(item);
      // Truncated function arguments must never become executable tool calls.
      const args = JSON.parse(call.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Provider returned invalid function arguments');
      calls.push({ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } });
      if (reasoningItems.length) reasoning.set(call.call_id, reasoningItems);
    } else if (item.type === 'message') {
      const message = z.object({ role: z.literal('assistant'), content: z.array(z.record(z.string(), z.unknown())) }).parse(item);
      for (const part of message.content) {
        if (part.type === 'output_text') texts.push(z.string().parse(part.text));
        else if (part.type === 'refusal') texts.push(z.string().parse(part.refusal));
        else throw new Error('Provider returned unsupported output content');
      }
    } else if (item.type !== 'reasoning') throw new Error('Provider returned unsupported output item');
  }
  while (reasoning.size > 128) reasoning.delete(reasoning.keys().next().value!);
  if (response.status === 'incomplete' && calls.length) throw new Error('Provider returned incomplete function calls');
  if (!texts.length && !calls.length) throw new Error('Provider returned no releasable output');
  return {
    id: response.id, object: 'chat.completion', created: response.created_at ?? Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: texts.join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: response.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens,
      ...(response.usage.input_tokens_details ? { prompt_tokens_details: response.usage.input_tokens_details } : {}),
      ...(response.usage.output_tokens_details ? { completion_tokens_details: response.usage.output_tokens_details } : {}),
    },
  };
}

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from app import add, greet


def test_add():
    assert add(2, 3) == 5


def test_greet():
    assert greet("Ada") == "Hello, Ada!"

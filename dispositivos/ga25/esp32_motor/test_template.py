import ast
from pathlib import Path

source = Path(__file__).with_name("captive_portal.py").read_text()
module = ast.parse(source)
page = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "_page")
for node in ast.walk(page):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format" and len(node.keywords) > 1:
        assert any(keyword.arg == "notice" for keyword in node.keywords)
print("portal-template-ok")

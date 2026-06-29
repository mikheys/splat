#!/usr/bin/env python3
"""Quick test to verify the FastAPI app loads."""
import sys
sys.path.insert(0, 'backend')
from main import app

print(f'✓ App loaded: {app.title}')
print(f'  Routes:')
for r in app.routes:
    methods = getattr(r, 'methods', {'GET'})
    print(f'    {",".join(methods):10s} {r.path}')

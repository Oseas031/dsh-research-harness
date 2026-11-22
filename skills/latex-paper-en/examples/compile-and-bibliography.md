# Example: Compile And Bibliography

User request:
Compile my IEEE paper, then tell me why two citations are unresolved in `main.tex`.

Recommended module sequence:
1. `compile`
2. `bibliography`

Commands:
```bash
python3 -B <skill-dir>/scripts/compile.py main.tex
python3 -B <skill-dir>/scripts/verify_bib.py references.bib --tex main.tex
```

Expected output:
- Build result with the exact failing command if compilation breaks.
- `% COMPILE ...` or `% BIBLIOGRAPHY ...` comments pointing to unresolved references or missing BibTeX keys.

# Modão field audit — plan

Spec: the 20 numbered items of the field audit (docs/superpowers/plans/field-audit-spec.md).

## Global Constraints
- VERIFY BEFORE CHANGING. Each item carries a "VERIFY:" line. Run it against the
  current code first. Classify ALREADY DONE / PARTIAL / MISSING.
- Implement only PARTIAL and MISSING. Leave passing code alone. No refactors of
  code that already satisfies its item.
- Every implemented item gets a regression test in tests/core.test.ts (units) or
  src/main/smokeE2E.ts (e2e), matching the file's existing style.
- `npm run typecheck` and `npm run test:units` must pass.
- Encoding: modloader.ini and MixMods readmes are Windows-1252 (iconv-lite
  'win1252'). Never UTF-8.
- Never delete game files. Quarantine.
- Mod Loader non-destructive disable = folder prefix ". " (dot + space).
- Priority 1-100, default 50, 0 = not loaded, higher wins file conflicts.
- Image base 0x400000 is added exactly once, and only when the faulting module
  is gta_sa.exe.
- Reference implementation for several items (same stack):
  https://github.com/DevilNine/san-andreas-mod-manager

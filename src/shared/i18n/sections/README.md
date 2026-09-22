One file per area of the app. Each exports `{ pt, en }` for its own keys, so two
people (or two agents) can translate different screens without touching the same
file. `../pt-BR.ts` and `../en.ts` merge them; nothing else imports from here.

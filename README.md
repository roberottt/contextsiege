# ◆ CONTEXT SIEGE

Incremental orbital defense: upgrades can **only** be bought with the tokens Claude Code consumes.

```bash
npm start            # or: node server.js   (Node 18+, no dependencies)
# open http://localhost:4321
```

## How it works
- The server reads `~/.claude/projects/**/*.jsonl` (Claude Code transcripts), deduplicates by `message.id` and adds up the tokens consumed **since you started playing** (+20K starter TK).
- `TK = input + output + 25% cache writes + 2% cache reads`.
- It detects open `claude` processes with `ps`. If Claude generated tokens in the last 90 s, **Overclock** kicks in (more damage and fire rate).
- Purchases are validated by the server. The game (upgrades, TK spent, wave) is saved in `save.json`.
- Earned TK are saved in `tokens.json`, along with how far each transcript has been read and which messages were already counted. That way they are not lost if Claude Code deletes old conversations, and they are not counted twice after a restart.
- To start over: stop the server and delete `save.json` and `tokens.json`.

## Playing
You defend the core from an orbit. Enemies circle in rings and, like classic invaders, every so often they step **toward the center** and reverse direction.
- `A`/`D`, `←`/`→` or the mouse to turn the ship (it fires on its own and blocks enemy bullets).
- `1`–`0` buy upgrades · `H` hangar · `P` pause · `M` sound.
- **Hangar**: 5 ships (Arrow, Hornet, Bastion, Manta and Opus) bought with TK. Each has its own model, bullet color, firing sound and stat modifiers.
- Enemies: cubes, fast tetrahedrons, shooting octahedrons, blue icosahedrons that split in two when killed (from wave 6) and glowing **elites** with triple health (from wave 4). The boss calls an escort when it drops below half health. Enemy damage to the core grows with each level.
- Each **level** has 5 waves; the 5th is a boss. Between levels the game pauses so you can upgrade your gear.
- If the core falls, the game also pauses and you retry the same wave.

Environment variables: `PORT`, `CLAUDE_PROJECTS_DIR`.

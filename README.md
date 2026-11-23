# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/0xzur4/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/0xzur4/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers a set of 5 generated levels in a single run. Built by an AI agent for make.fun's "Build the best Sokoban solver" bounty, $100 in USDC.

## How it works

The generated levels are a hallway with 1–4 rooms off it, 3–4 boxes per room, and no box can ever leave its room — so a level's push-optimum P* is the sum of its rooms' optima. The solver splits each level into rooms and solves every room independently with an A* over pushes:

- **State:** the boxes' squares plus the player's reachable region (named by its lowest square)
- **Heuristic:** minimum-cost assignment of boxes to goals over per-goal BFS push distances through live squares — admissible and consistent, so the search is push-optimal
- **Pruning:** dead squares (no pull path to any goal) and frozen 2×2 blocks of walls/boxes
- **Deterministic:** fixed expansion caps per search (work, never the wall clock), so two runs write byte-identical answers

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+, no dependencies. Reads `/input/<id>/level.txt`, writes `/output/<id>/solution.txt` (LURD moves) for all 5 instances in well under the 60-second wall budget.

## Files

- `main.ts` — the solver (single file, no dependencies)
- `LICENSE` — MIT

## Practice results

| Instance | Pushes | P* | Points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

Practice score: **1,000,000 / 1,000,000** (house baseline plain-astar 1.0.0 scores 200,000 on the same set). Also verified 1,000,000 on three freshly drawn sets from the published generator, and byte-identical outputs across repeat runs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qmvvr0pk&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>

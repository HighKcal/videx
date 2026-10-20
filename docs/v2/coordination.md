# VIDEX v2 coordination checkpoint

User authorization: implement complete attached specs; no push; user unavailable overnight. No commits made/requested. Latest correction: OpenAI TTS required (overrides MD local-only voice restriction). Keep image transport direct OpenAI for requested stills only.

Baseline main and backup v0.0.0: f7f0ea496dc4a06bf15a98eee14e08dea186f071. Main implementation location: /home/minwoo/.superset/projects/videx. Original coordinator linked worktree is left unchanged.

Shared contract: /home/minwoo/.hermes/profiles/dev-lead/cache/scratch/videx-v2-team-brief.md
Superset workspace: 35313178-7322-4b88-b2c0-9abf30a46834, host local (1bb5c29fa762c73db5e3d132fd5c1da1).

| Task | Worker | Transport/session | Ownership | State |
|---|---|---|---|---|
| FIRMWARE | dev-senior | Superset df9b9e41-79f5-4369-83bd-456a11771cf1 | cam (not vendors), proxy/main, C tests | implementing |
| CORE | dev-mid | Superset 1dbdb4cf-4f36-4978-acf1-61ab02d80c30 | mobile except vision/ui, npm sole owner | implementing |
| VISION | dev-junior | Superset ce20ccaf-65ab-4288-ad14-a8a29b28b00b | mobile/src/vision, tests/vision* | implementing |
| UI | coop-design | direct configured wrapper, terminal proc_ec3d893e1ccc (PID1236094) | mobile/src/ui | implementing |
| DOCS | coop-docs | Superset wrapper launched after stale docs preset failed; reacquire terminal id | docs/v2 requirements/validation/README/spec-notes | implementing |

Superset host service became stale/unresponsive while launching additional workers. Existing PTY workers survived. Desktop host restart was attempted via /opt/Superset/superset; repeated CLI create timeouts. coop-docs verified running PID1234609. Designer launched directly with exact configured profile after repeated failed Superset launches. Reacquire live terminal mappings before communication, verify no late duplicate UI task.

Dependency interfaces fixed in shared brief: VDX2 24-byte envelope + 28-byte CAM2 + JPEG; /ws authenticate then connected; observed resolution ACK; event id+epoch; ObstacleDetector API; VidexScreen props. Main workers share worktree only with disjoint file ownership.

Required final verification: coordinator run mobile unit/build/E2E, C host tests, any feasible ESP-IDF build and legacy Python regression tests in isolated environment. Freeze workers before union checks. Read handoff evidence, review firmware/protocol/privacy/mode/speech cancellation, independently exercise browser minimal UI and mocked-only flows. Real hardware, valid deployed local WSS trust, mobile OS behavior, real paid API calls are unverified release gates, not fabricated passes.

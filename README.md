# word-challenge server (deployed)

"오늘의 단어 챌린지" 백엔드. Render 웹서비스 + Render Postgres로 배포됩니다.

- `GET /` — 번들된 프론트엔드(final.html)
- `GET /healthz` — 헬스 체크
- `/api/*` — REST API (words, memos, attempts, stats). 상세 내용은 프로토타입 저장소의 server/README.md 참고.

`ANTHROPIC_API_KEY` 환경변수를 설정하면 `/api/memos/:id/generate`(메모 단어를 실제로 리서치해서 문제로 변환)가 활성화됩니다.

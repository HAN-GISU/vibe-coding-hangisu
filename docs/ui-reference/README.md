# UI 참고 자료

화면 모양을 만들 때 참고하는 자료다. CLAUDE.md 4장 "화면 모양 (UI)"의 근거 자료다.

- 출처: shadcn/ui 공식 사이트 (https://ui.shadcn.com). 2026-10-12에 어두운 테마로 캡처했다.
- shadcn/ui는 MIT 라이선스다. 이 저장소는 **라이브러리를 설치하지 않고 생김새만 일반 HTML·CSS로 따라 만든다** (CLAUDE.md 2-2).
- 색과 크기 값은 [tokens.css](tokens.css)에 있다. 데모 화면에서 실제 계산값을 읽어 옮긴 것이라 그대로 써도 된다.

## 캡처 목록

| 파일 | 원본 | 볼 것 | 우리 화면에서 쓰는 곳 |
|---|---|---|---|
| [01-dashboard.png](screenshots/01-dashboard.png) | 대시보드 데모 `dashboard-01` | 전체 배치: 왼쪽 사이드바, 위쪽 얇은 머리줄, 본문 카드 | 메인 화면 전체 구조 |
| [02-dashboard-full.png](screenshots/02-dashboard-full.png) | 같은 화면, 아래까지 | 카드 → 표로 이어지는 세로 흐름, 표 위 탭과 버튼 | 메인 화면 게임 목록 |
| [03-dashboard-mobile.png](screenshots/03-dashboard-mobile.png) | 같은 화면, 폭 390px | 좁은 화면에서 사이드바가 사라지고 카드가 한 줄씩 쌓임. 오른쪽이 잘린 건 캡처 도구 한계다 | 폰 화면 (사이드바는 위쪽 목록으로 옮긴다, CLAUDE.md 4장) |
| [04-form.png](screenshots/04-form.png) | 로그인 폼 데모 `login-01` | 카드 안의 라벨, 입력칸, 버튼 모양과 간격 | 설정 화면 입력 (Form). **모양만 참고한다. 로그인 기능은 과제상 금지다.** |
| [05-table.png](screenshots/05-table.png) | Table 문서 | 머리줄, 행 구분선, 오른쪽 정렬 숫자 | 기록 화면 기간별 함/안함 표 (Table) |
| [06-card.png](screenshots/06-card.png) | Card 문서 | 카드 제목, 설명, 본문, 아래 버튼 영역 | 게임 카드 |
| [07-checkbox.png](screenshots/07-checkbox.png) | Checkbox 문서 | 체크박스와 라벨 | 숙제 체크 |
| [08-badge.png](screenshots/08-badge.png) | Badge 문서 | 작은 알약 모양 표시 | `D-2`, `35시간`, `안함 (묶음 달성)` 같은 상태 표시 |
| [09-dialog-open.jpg](screenshots/09-dialog-open.jpg) | Dialog 문서, 열린 상태 | 뒤를 어둡게 흐린 위에 뜨는 창, 오른쪽 아래 [취소] [저장] | 삭제 확인, 리셋 주기 추가(+) 창 (Dialog) |

`05`~`08`은 문서 페이지 전체를 찍었다. 가운데 미리보기 상자만 보면 된다.

## 잰 값 (dashboard-01, 폭 1440px)

| 항목 | 값 |
|---|---|
| 사이드바 폭 | 288px |
| 위쪽 머리줄 높이 | 48px |
| 본문 좌우 여백 | 24px |
| 카드 모서리 / 안쪽 여백 / 카드 사이 간격 | 14px / 24px / 16px |
| 카드 테두리 | 1px, 흰색 10% 투명 (`--border`) |
| 카드 그림자 | 거의 없음 (0 1px 2px, 5%) |
| 카드 큰 숫자 | 30px, 굵기 600 |
| 본문·버튼·사이드바 글자 | 14px |
| 사이드바 항목 높이 / 모서리 | 32px / 8px |
| 버튼 높이 / 모서리 | 32~36px / 8px |
| 배지 | 높이 22px, 글자 12px, 완전히 둥근 알약 모양 |
| 표 머리줄 / 한 줄 높이 | 40px / 53px |

## 따라 하지 않을 것

- 차트, 매출 숫자 카드처럼 우리 기능에 없는 요소
- Geist 글꼴: 한글이 없고 외부 글꼴이라 쓰려면 먼저 묻는다 (CLAUDE.md 2-2). 기본은 시스템 글꼴이다.
- 로그인, 계정 관련 화면 (04는 폼 모양만 본다)

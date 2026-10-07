# 작업 규칙

이 저장소는 `index.html` 한 파일로 된 9인제 배구 전술 시뮬레이터예요(Vercel로 배포, `main` 머지 시 실제 사이트 반영).

## 기능을 바꿀 때마다 안내 문구도 함께 고쳐요 (필수)

화면이나 동작을 추가·변경·삭제하면, 같은 커밋에서 프로그램 안의 안내 문구를 모두 실제 동작에 맞게 고쳐요.
확인할 곳:

- **기능 설명 & 사용 설명 창** (`#featureGuideModal`)
  - 단계별 카드: 스크립트의 `GUIDE_STEPS` (sim / video / settings). 단계의 `title`·`text`와 데모 `scene`·`script`
  - 접힌 참고사항: `#guideSection-*` 안의 `.guide-note-box`, 예시표 `.guide-example`
- **로그인 화면 소개창** (`#introModal`): 기능 목록
- **각 카드의 안내**: `.field-note`, `ℹ️ 참고사항` 패널(`#presetInfoPanel`, `#attackInfoPanel`, `#landingInfoPanel` 등), `💡 폴더 이름 정하는 Tip`
- 버튼·placeholder·alert 문구 중 바뀐 동작을 설명하는 것

없어진 기능을 가리키는 문구(예: 지운 버튼 이름)가 남아 있지 않은지 `grep`으로 확인해요.

## 기타

- 화면 문구는 모두 한국어 해요체로 써요.
- 바꾼 뒤에는 Playwright(크로미움 `/opt/pw-browsers/chromium`)로 페이지를 열어 오류가 없는지와 바뀐 화면을 확인해요.

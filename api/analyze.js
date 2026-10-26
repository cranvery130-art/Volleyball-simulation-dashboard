/* 경기 분석(AI) — 유튜브 경기 영상을 Google Gemini가 보고 랠리·득실을 읽어 주는 Vercel 서버리스 함수
   - Gemini API 키는 쓰는 사람이 자기 키를 화면에 넣어 요청 머리(x-gemini-key)로 보내요. 사용량·요금은 그 사람 계정에 쌓이고, 키는 저장하지 않아요.
   - 환경 변수: GEMINI_MODEL(선택, 기본은 아래 목록을 차례로 시도)
   - 받는 것: 공개 유튜브 링크, 볼 구간(초), 1초에 볼 장면 수, 두 팀 유니폼 설명·이름. 아무것도 저장하지 않아요.
   - 한 번에 짧은 구간만 봐요(화면이 구간을 나눠 여러 번 부르고, 랠리마다 다시 자세히 봐요). */
const MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
const MAX_SPAN = { scores: 300, rallies: 240, detail: 40 }; // 한 번에 볼 수 있는 최대 길이(초)
const hits = new Map(); // 같은 인스턴스 안에서만 유지되는 간단한 남용 방지(1분 30회)

const OPTIONS = ['레프트', '라이트', 'A', 'B', '백A', '앞차', '백차', '다이렉트', '세터페인트(2구 넘김)', '3구처리',
  '서브', '서브캐치', '리시브', '토스', '2단토스', '2단연결', '블로킹', '파울(반칙)'];
const TOSS_TO = ['레프트', '라이트', 'A', 'B', '백A', '앞차', '백차', '3구처리', '세터 2구'];
// 수동 기록의 '관련 선수'처럼 포지션으로 받아요(화면이 명단의 같은 포지션 선수로 바꿔요)
const ROLES = { LEFT: '레프트', SETTER: '세터', RIGHT: '라이트', QA: '속공수(A)', QBACKA: '속공수(빽A)', FRONTSLIDE: '앞차', BACKSLIDE: '빽차', LBACK: '레프트백', CBACK: '센터백', RBACK: '라이트백' };
const ROLE_TEXT = Object.entries(ROLES).map(([k, v]) => `${k}=${v}`).join(', ');

const BASE = `당신은 9인제 배구(한국 생활체육) 경기 기록원입니다. 유튜브 경기 영상을 보고 사실만 기록합니다.
9인제 배구: 한 팀 9명, 로테이션 없음, 앞줄 3명·가운데 3명·뒷줄 3명. 21점 세트(듀스 가능), 3세트 중 2세트 선승이 흔합니다.
공격 위치 이름: 레프트(공격하는 팀 기준 왼쪽 끝 오픈), 라이트(오른쪽 끝), A(세터 앞 빠른 속공), B(A보다 조금 떨어진 속공),
앞차(시간차, 속공수가 페이크 뒤 옆에서 때림), 백차(세터 뒤쪽으로 옮겨 때리는 시간차), 백A(세터 뒤 속공), 다이렉트(상대가 넘긴 공을 바로 때림),
세터페인트(2구 넘김), 3구처리(셋째 터치로 넘긴 공).
왼쪽·오른쪽은 언제나 그 플레이를 한 팀이 네트를 바라볼 때 기준입니다.
보이지 않거나 확실하지 않은 것은 지어내지 말고 null 또는 "unknown"으로 두고 confidence를 낮게 줍니다.
시간은 반드시 영상 전체 기준 초(숫자)로 씁니다.

[코트 라인] 9인제 코트는 길이 21m·너비 10.5m(한쪽 10.5m×10.5m)이고, 네트 가운데 아래 센터라인이 두 코트를 나눕니다. 라인 위에 떨어진 공은 인입니다.
체육관 바닥에는 농구·배드민턴 등 다른 종목 선도 많습니다. 선심(깃발을 든 심판)은 코트 모서리 바깥에 서서 자기 앞의 사이드라인·엔드라인을 맡으므로,
선심이 서 있는 곳 바로 앞으로 이어진 선이 배구 경기장 라인입니다. 선심 위치로 코트 네 변을 먼저 찾고, 그 선을 기준으로 인·아웃을 봅니다.
[심판 판정] 득실은 선수와 공만 보지 말고 심판 판정을 기준으로 정합니다. 영상으로 애매해도 심판이 선언하면 그대로 점수가 됩니다.
- 주심(네트 옆 높은 심판대)은 랠리가 끝나면 다음 서브를 넣을 팀(=점수를 딴 팀) 쪽으로 팔을 뻗어 가리킵니다. 이것이 득점 팀입니다.
- 주심·부심 반칙 수신호: 네트터치(손으로 네트를 가리키거나 만짐), 오버네트(손을 네트 위로 넘겨 내림), 센터라인 침범(센터라인을 가리킴),
  포히트(손가락 4개), 더블컨택(손가락 2개), 홀딩(손바닥을 위로 천천히 들어 올림), 서브 풋폴트(엔드라인을 가리킴), 안테나 반칙(안테나를 가리킴). 수신호 뒤 가리킨 팀이 득점합니다.
- 선심 깃발: 깃발을 위로 들면 아웃, 깃발을 코트 바닥 쪽으로 내려 가리키면 인, 깃발을 세우고 다른 손바닥으로 깃발 끝을 쓸면 터치아웃(수비·블로커에 맞고 나감).
- 심판 판정이 공의 겉보기 결과와 다르면 심판 판정을 따릅니다.`;

function teamsText(b) {
  return `우리팀: ${b.ourName || '우리팀'} (유니폼: ${b.ourDesc || '설명 없음'})
상대팀: ${b.oppName || '상대팀'} (유니폼: ${b.oppDesc || '설명 없음'})` + (b.ourSide ? `\n영상 시작 때 우리팀 위치: 화면 ${b.ourSide}` : '');
}

function promptFor(b) {
  if (b.mode === 'scores') {
    return `${teamsText(b)}
이 요청은 영상의 ${b.start}초부터 ${b.end}초까지만 봅니다. 공의 움직임은 보지 말고 **화면의 점수판만** 읽습니다
(방송 자막 점수, 경기장 전광판, 손으로 넘기는 점수판 모두 포함).
- 구간 시작 때 보이는 점수를 첫 항목으로 적고(time=처음 보인 시각), 그 뒤 점수판 숫자가 바뀔 때마다 한 항목씩 순서대로 모두 적습니다.
- 각 항목: time(숫자가 바뀐 시각, 영상 전체 기준 초), our·opp(바뀐 뒤 우리팀·상대팀 점수), set(점수판에 세트 번호나 세트 스코어가 보이면 지금 세트 번호, 아니면 null), confidence(0~1).
- 어느 숫자가 어느 팀인지는 점수판의 팀 이름·색과 위 유니폼 설명으로 판단하고, 그 근거를 mapping에 짧게 적습니다. 끝까지 같은 기준을 지킵니다.
- 다시보기 화면, 다른 경기 점수, 숫자가 가려져 확실히 안 읽히는 순간은 적지 않습니다.
- 점수판이 전혀 안 보이면 boardVisible=false, changes=[] 로 답합니다.`;
  }
  if (b.mode === 'rallies') {
    return `${teamsText(b)}
이 요청은 영상의 ${b.start}초부터 ${b.end}초까지만 봅니다.
이 구간에서 끝난 랠리(서브부터 공이 죽을 때까지)를 모두 찾아 순서대로 적습니다. 구간 시작 전에 시작해 구간 안에서 끝난 랠리도 포함하고, 구간 끝에서 아직 안 끝난 랠리는 뺍니다.
각 랠리: start(서브 시각), end(공이 죽은 시각), winner(점수를 딴 팀 our|opp|unknown), how(결정 방법 attack|serve|block|opp_error|unknown),
server(서브한 팀 our|opp|unknown), scoreAfter(점수판이나 자막에 보이는 랠리 뒤 점수 {our,opp}, 안 보이면 null), set(보이면 세트 번호, 아니면 null),
replay(다시보기 화면이면 true — 같은 랠리를 두 번 세지 않도록), confidence(0~1), note(짧은 한국어 설명).
작전타임·교체·다시보기 장면은 랠리가 아닙니다.
winner는 랠리 끝에 주심이 팔로 가리킨 팀(선심 깃발·반칙 수신호 포함 심판 판정)을 먼저 따르고, 심판이 안 보일 때만 공을 보고 정합니다. end는 주심이 가리킨 시각까지 포함합니다.`;
  }
  return `${teamsText(b)}
이 요청은 랠리 하나만 봅니다: 영상 ${b.start}초~${b.end}초.${b.hint ? `\n앞 단계에서 본 내용(틀릴 수 있음): ${b.hint}` : ''}
${b.angle ? `이번에는 이렇게 봅니다: ${b.angle}\n` : ''}이 랠리의 마지막 점수를 결정한 플레이를 기록합니다. 득실과 반칙은 위 [심판 판정]을 먼저 따릅니다(랠리가 끝난 뒤 몇 초 동안 주심·선심을 봅니다).${b.layout ? `
[포지션 자리] 9인제는 자리가 고정이에요. 이 팀들은 아래 자리에 서요(전술 시뮬레이션에 놓아 둔 대형, 그 팀이 네트를 바라볼 때 기준). 선수가 서 있는 자리를 이 대형과 맞춰 포지션을 정합니다.
${b.layout}` : ''}
- winner: 점수를 딴 팀(our|opp|unknown)
- team: 결정적 플레이를 한 팀(our|opp). 잘해서 났으면 딴 팀, 실수(아웃·네트·반칙·서브 범실 등)로 났으면 실수한 팀입니다.
- outcome: score(잘해서 득점) | fault(실수로 실점)
- option: 결정적 플레이 종류, 다음 중 하나: ${OPTIONS.join(', ')}
- detail: option이 공격이면 득점일 때 '강타·빈 곳'|'강타·사람 쪽'|'가볍게 볼처리'|'페인트'|'터치아웃'|'블로킹 맞고 네트인'|'네트싸움'|'삑사리', 실점일 때 '아웃'|'네트 걸림'|'네트싸움'|'삑사리';
  블로킹 득점이면 '1인 블로킹'~'4인 블로킹', 파울이면 반칙 이름(네트터치·아웃(라인 밖)·포히트·더블컨택·홀딩·서브 풋폴트 등). 모르면 null.
- ball: 공격·서브라면 공이 떨어진 곳 {col,row}. col 0=왼쪽 1=가운데 2=오른쪽(공을 보낸 팀이 네트를 바라볼 때 기준), row 0=네트 가까운 앞 1=중간 2=뒤. 모르면 null.
- 관련 선수(수동 기록원이 팀별로 '관련 선수'를 고르듯 양 팀 모두): 우리 공격이 막혔으면 우리 공격수와 상대 블로커, 공격 득점이면 공격수와 (닿았다면) 받지 못한 상대 수비수,
  서브면 서버와 받은 선수, 범실·반칙이면 실수한 선수. 관련 없는 팀은 null.
  ourRole / oppRole: 그 선수의 포지션(${ROLE_TEXT}) — 9인제는 자리가 고정이라 코트 위치로 판단합니다. 모르면 null.
  ourNumber / oppNumber: 그 선수의 등번호(보이면), 아니면 null.
- blockZone: option이 블로킹이거나 블로킹이 결정적이었으면, 블로킹한 팀이 네트를 바라볼 때 기준 네트 앞 자리 0=레프트 앞 1=앞차 앞 2=A 앞 3=백차(백A) 앞 4=라이트 앞. 아니면 null.
- tosses: 이 랠리에서 올라간 토스를 순서대로 [{team:our|opp, to:${TOSS_TO.join('|')}}]. 모르면 빈 배열.
- refereeSeen: 주심·선심의 판정 동작이 보였으면 true. refereeCall: 본 판정을 짧게(예: '주심이 상대팀 가리킴', '선심 깃발 위로=아웃', '네트터치 수신호'), 못 봤으면 null.
  lineCall: 선심 판정 in|out|touch|none(선심 판정 없음). 심판이 반칙을 선언했으면 option은 '파울(반칙)', detail은 그 반칙 이름으로 씁니다.
- confidence(0~1), note(짧은 한국어 설명).`;
}

const SCHEMA = {
  scores: {
    type: 'OBJECT',
    properties: {
      boardVisible: { type: 'BOOLEAN' },
      mapping: { type: 'STRING' },
      changes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            time: { type: 'NUMBER' }, our: { type: 'INTEGER' }, opp: { type: 'INTEGER' },
            set: { type: 'INTEGER', nullable: true }, confidence: { type: 'NUMBER' },
          },
          required: ['time', 'our', 'opp'],
        },
      },
    },
    required: ['boardVisible', 'changes'],
  },
  rallies: {
    type: 'OBJECT',
    properties: {
      rallies: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            start: { type: 'NUMBER' }, end: { type: 'NUMBER' },
            winner: { type: 'STRING', enum: ['our', 'opp', 'unknown'] },
            how: { type: 'STRING', enum: ['attack', 'serve', 'block', 'opp_error', 'unknown'] },
            server: { type: 'STRING', enum: ['our', 'opp', 'unknown'] },
            scoreAfter: { type: 'OBJECT', nullable: true, properties: { our: { type: 'INTEGER' }, opp: { type: 'INTEGER' } } },
            set: { type: 'INTEGER', nullable: true },
            replay: { type: 'BOOLEAN' },
            confidence: { type: 'NUMBER' }, note: { type: 'STRING' },
          },
          required: ['start', 'end', 'winner', 'confidence'],
        },
      },
    },
    required: ['rallies'],
  },
  detail: {
    type: 'OBJECT',
    properties: {
      winner: { type: 'STRING', enum: ['our', 'opp', 'unknown'] },
      team: { type: 'STRING', enum: ['our', 'opp'] },
      outcome: { type: 'STRING', enum: ['score', 'fault'] },
      option: { type: 'STRING', enum: OPTIONS },
      detail: { type: 'STRING', nullable: true },
      ball: { type: 'OBJECT', nullable: true, properties: { col: { type: 'INTEGER' }, row: { type: 'INTEGER' } } },
      ourRole: { type: 'STRING', enum: Object.keys(ROLES), nullable: true },
      oppRole: { type: 'STRING', enum: Object.keys(ROLES), nullable: true },
      ourNumber: { type: 'INTEGER', nullable: true },
      oppNumber: { type: 'INTEGER', nullable: true },
      blockZone: { type: 'INTEGER', nullable: true },
      refereeSeen: { type: 'BOOLEAN' },
      refereeCall: { type: 'STRING', nullable: true },
      lineCall: { type: 'STRING', enum: ['in', 'out', 'touch', 'none'], nullable: true },
      tosses: { type: 'ARRAY', items: { type: 'OBJECT', properties: { team: { type: 'STRING', enum: ['our', 'opp'] }, to: { type: 'STRING', enum: TOSS_TO } } } },
      confidence: { type: 'NUMBER' }, note: { type: 'STRING' },
    },
    required: ['winner', 'team', 'outcome', 'option', 'confidence'],
  },
};

function youtubeId(u) {
  const m = String(u || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function parseJson(t) {
  if (!t) return null;
  const s = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* 아래에서 다시 시도 */ }
  const a = s.indexOf('{'); const z = s.lastIndexOf('}');
  if (a >= 0 && z > a) { try { return JSON.parse(s.slice(a, z + 1)); } catch (e) { return null; } }
  return null;
}

async function callGemini(key, model, b, id) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: BASE }] },
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` }, videoMetadata: { startOffset: `${b.start}s`, endOffset: `${b.end}s`, fps: b.fps } },
          { text: promptFor(b) },
        ],
      }],
      generationConfig: {
        temperature: b.mode === 'detail' ? 0.4 : b.mode === 'scores' ? 0 : 0.2,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA[b.mode],
        // 랠리 찾기는 움직임만 보면 돼서 낮은 화질로 아껴요. 랠리 자세히 보기는 기본 화질로 봐요.
        ...(b.mode === 'rallies' ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 받아요.' }); return; }
  // 같은 사이트에서 온 요청만 받아요
  const origin = req.headers.origin || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (origin && host && !origin.endsWith('//' + host)) { res.status(403).json({ error: '허용되지 않은 요청이에요.' }); return; }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const now = Date.now(); const h = (hits.get(ip) || []).filter(t => now - t < 60000); h.push(now); hits.set(ip, h);
  if (h.length > 30) { res.status(429).json({ error: '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.' }); return; }

  // 쓰는 사람 자신의 키만 써요(사이트 주인의 키로 대신 내 주지 않아요)
  const key = String(req.headers['x-gemini-key'] || '').trim();
  if (!key) { res.status(401).json({ error: '🔑 내 Gemini API 키를 먼저 넣어 주세요.', code: 'nokey' }); return; }
  // 키 모양은 Google이 바뀔 수 있어서(예: 점이 들어간 새 키) 여기서는 길이·글자만 보고, 맞는지는 Google이 판단해요
  if (!/^[\x21-\x7E]{10,300}$/.test(key)) { res.status(401).json({ error: 'API 키에 빈칸이나 다른 글자가 섞였어요. AI Studio의 복사 버튼으로 다시 복사해 붙여 주세요.', code: 'badkey' }); return; }
  const raw = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : (req.body || {});
  const id = youtubeId(raw.url);
  if (!id) { res.status(400).json({ error: '유튜브 영상 링크를 확인해 주세요.' }); return; }
  const mode = ['scores', 'detail'].includes(raw.mode) ? raw.mode : 'rallies';
  const start = Math.max(0, Math.floor(Number(raw.start) || 0));
  const end = Math.floor(Number(raw.end) || 0);
  if (!(end > start) || end - start > MAX_SPAN[mode]) { res.status(400).json({ error: `한 번에 ${MAX_SPAN[mode]}초까지만 볼 수 있어요.` }); return; }
  const clean = (v, n) => String(v || '').replace(/[<>`]/g, '').slice(0, n || 60);
  const b = {
    mode, start, end,
    fps: Math.min(mode === 'detail' ? 10 : mode === 'scores' ? 2 : 4, Math.max(0.5, Number(raw.fps) || (mode === 'detail' ? 4 : 1))),
    ourName: clean(raw.ourName, 30), oppName: clean(raw.oppName, 30), ourDesc: clean(raw.ourDesc), oppDesc: clean(raw.oppDesc),
    ourSide: clean(raw.ourSide, 20), hint: clean(raw.hint, 300), angle: clean(raw.angle, 200), layout: clean(raw.layout, 1800),
  };

  const models = [process.env.GEMINI_MODEL, ...MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  let last = null;
  for (const m of models) {
    let r;
    try { r = await callGemini(key, m, b, id); } catch (e) { last = { status: 502, msg: 'AI 서버에 연결하지 못했어요.' }; break; }
    const errText = JSON.stringify(r.j.error || '');
    if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(errText) || r.status === 403) { last = { status: 401, msg: 'API 키가 맞지 않거나 쓸 수 없는 키예요. 🔑 키를 다시 확인해 주세요.', code: 'badkey' }; break; }
    if (r.status === 404 || (r.status === 400 && /model/i.test(errText))) { last = { status: 502, msg: `모델(${m})을 쓸 수 없어요.` }; continue; }
    if (r.status === 429) {
      // 하루 한도와 1분 한도를 나눠 알려 줘요(화면이 기다리는 시간이 달라요)
      const daily = /per ?day|PerDay|daily/i.test(errText);
      last = daily ? { status: 429, code: 'daily', msg: '내 키의 하루 AI 사용량을 다 썼어요.' } : { status: 429, code: 'minute', msg: '1분 사용량 한도에 걸렸어요.' };
      break;
    }
    if (r.status === 400 && /video|youtube|file/i.test(errText)) { last = { status: 400, msg: '이 영상을 읽지 못했어요. 공개 영상인지 확인해 주세요.' }; break; }
    if (r.status !== 200) { last = { status: 502, msg: `AI 분석에 실패했어요(${r.status}).` }; break; }
    const cand = (r.j.candidates || [])[0];
    const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || '').join('');
    const out = parseJson(text);
    if (!out) { last = { status: 502, msg: 'AI 응답을 읽지 못했어요. 다시 시도해 주세요.' }; break; }
    const usage = r.j.usageMetadata || {};
    res.status(200).json({ model: m, mode, start, end, result: out, tokens: usage.totalTokenCount || null });
    return;
  }
  res.status((last && last.status) || 502).json({ error: (last && last.msg) || 'AI 분석에 실패했어요.', code: last && last.code });
};

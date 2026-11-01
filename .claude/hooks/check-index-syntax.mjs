// index.html을 고친 뒤 안의 <script> 문법을 검사하는 Claude Code 훅(PostToolUse)
// - 괄호 하나만 빠져도 사이트 전체가 멈추므로, 고칠 때마다 0.3초 안에 검사해요.
// - 오류가 있으면 줄 번호와 함께 알려 주고(exit 2) Claude가 바로 다시 고치게 해요.
// - 수동 실행: node .claude/hooks/check-index-syntax.mjs index.html
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

let target = process.argv[2];
if (!target) {
  let input = '';
  try { input = readFileSync(0, 'utf8'); } catch { process.exit(0); }
  try { target = JSON.parse(input)?.tool_input?.file_path; } catch { process.exit(0); }
}
if (!target || !/(^|[\\/])index\.html$/.test(target)) process.exit(0);

let html;
try { html = readFileSync(resolve(target), 'utf8'); } catch { process.exit(0); }

const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const errors = [];
let m;
while ((m = re.exec(html))) {
  const attrs = m[1];
  if (/\bsrc\s*=/.test(attrs)) continue;
  const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
  if (type && !/^(text\/javascript|application\/javascript)$/i.test(type)) continue; // 모듈·JSON 등은 건너뜀
  const codeStart = m.index + m[0].indexOf('>') + 1;
  const lineOffset = html.slice(0, codeStart).split('\n').length - 1;
  try {
    new vm.Script(m[2], { filename: 'index.html', lineOffset });
  } catch (e) {
    if (!(e instanceof SyntaxError)) continue;
    const where = (e.stack || '').match(/index\.html:(\d+)/);
    errors.push(`index.html ${where ? where[1] + '번째 줄' : `${lineOffset + 1}번째 줄부터 시작하는 스크립트`}: ${e.message}`);
  }
}

if (errors.length) {
  console.error('index.html 스크립트 문법 오류가 있어요. 이대로 배포하면 화면이 뜨지 않아요. 바로 고쳐 주세요.\n' + errors.join('\n'));
  process.exit(2);
}

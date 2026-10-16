// Test-observer utilities only. Never alter product timeouts or acknowledgements.
export async function within(label, work, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer=setTimeout(()=>reject(Error(label+' timed out')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
export function lineCollector(onLine) {
  let rest='';
  return {
    write(chunk) {
      const lines=(rest+chunk).split(/\r?\n/);rest=lines.pop();
      for(const line of lines)onLine(line);
    },
    end() { if(rest)onLine(rest);rest=''; },
  };
}

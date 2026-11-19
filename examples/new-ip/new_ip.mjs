// A new IP when your script decides, from Node.js 18 and newer with nothing to install
// (hproxy 0.4.9 and newer).
//
// Start the proxy so it stays on one proxy until asked:
//   hproxy connect --file proxies.txt --rotate on-failure --background
// Then:
//   node new_ip.mjs

const CONTROL = "http://127.0.0.1:8080/hproxy"; // the proxy's own address, then /hproxy

async function control(page, method = "GET") {
  const response = await fetch(`${CONTROL}/${page}`, { method });
  const answer = await response.json();
  if (!answer.ok) throw new Error(answer.error);
  return answer;
}

const now = await control("status");
console.log(`now:   proxy ${now.member} of ${now.members}, ${now.upstream}`);
// The open connections end with the switch, so the next request goes out the new way.
const after = await control("new-ip", "POST");
console.log(`after: proxy ${after.member} of ${after.members}, ${after.upstream}`);

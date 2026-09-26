import { useEffect, useState, type ReactNode } from "react";
import { copyText, toolCommand } from "../lib/tauri";
import { AgentMark, WorksWith, type MarkName } from "./AgentMarks";
import { BlockTitle, Button, Card, Chip, Icon, PageHead } from "./ui";

/* Use with AI: its own tab, not hidden in Settings, and as easy as it gets:
   it works with every kind of AI agent and shows their logos instead of
   listing names (AgentMarks.tsx, 2026-09-24), and instead of a
   releases page it hands over one text to paste into the agent and one to
   add to the agent's memory.

   Nothing to download: this app is the tool. Started with \`mcp\` it serves
   the tools and opens no window (src-tauri/src/main.rs), and it knows where it
   is, so every text below carries its real path: on Windows its own copy
   outside the install folder, which updates never have to end
   (src-tauri/src/tool.rs). The first block is written
   to the assistant: it adds HProxy to its own settings and remembers how to
   use it. The second is only the memory note. The setups by hand stay one
   click away, as each assistant's own documentation gives them (checked
   2026-09-23; ChatGPT is not among them, its app reaches remote servers only).

   Only things to copy and paste, never a fixed file path to open: no
   button opens another app or a page, and no text holds a file path. The
   command is `hproxy`, because the app puts its tool's folder on the user's
   PATH (src-tauri/src/tool.rs); only where that failed, or the person took it
   off, does the program's full path stand in.

   Keep this page, the README's "For AI assistants" and cli/src/mcp.rs saying
   the same thing. */

const MEMORY = `HProxy (the MCP server "hproxy") handles everything about proxies on this computer:
- proxy_check tests proxy lines in any format and returns the working ones, fastest first.
- proxy_list gives free public proxies; verify=true tests them here first.
- ip_lookup says where an address is.
- proxy_connect starts a local proxy on 127.0.0.1 that forwards through a proxy with its login added; use the http_proxy it returns with curl, a browser or Playwright.
- proxy_status, proxy_new_ip and proxy_disconnect show, change and stop that connection.
- app_open opens the HProxy app for me, or wakes it in the tray (background=true).
Never ask for or repeat proxy passwords. If a call fails, the answer names the right tool or argument: read it and call again.`;

/** The command line in a shell: quoted when the path has spaces. */
const shellArg = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

function setupPrompt(cmd: string): string {
  return `Please add HProxy to your tools. It is a local MCP server (stdio) on this computer that checks proxies and connects through them.

Add this MCP server to your own settings:
  name: hproxy
  command: ${cmd}
  args: mcp

As JSON, for most apps: {"mcpServers": {"hproxy": {"command": ${JSON.stringify(cmd)}, "args": ["mcp"]}}}
VS Code calls the list "servers" and needs "type": "stdio". Codex takes [mcp_servers.hproxy] in ~/.codex/config.toml. Claude Code: claude mcp add hproxy -- ${shellArg(cmd)} mcp

Tell me if you need a restart to see it. Then remember this:

${MEMORY}`;
}

type Setup = { name: string; mark: MarkName; where: ReactNode; snippet: (cmd: string) => string };

const json = (key: string, entry: object) => JSON.stringify({ [key]: { hproxy: entry } }, null, 2);

const SETUPS: Setup[] = [
  { name: "Claude Code", mark: "claude", where: "In a terminal:", snippet: (c) => `claude mcp add hproxy -- ${shellArg(c)} mcp` },
  {
    name: "Claude Desktop",
    mark: "claude",
    where: (
      <>
        Settings, Developer, <b>Edit Config</b> (claude_desktop_config.json), then restart Claude:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Cursor",
    mark: "cursor",
    where: (
      <>
        Paste into <b>~/.cursor/mcp.json</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "VS Code",
    mark: "vscode",
    where: (
      <>
        Paste into <b>.vscode/mcp.json</b> (VS Code says <b>servers</b>, not mcpServers):
      </>
    ),
    snippet: (c) => json("servers", { type: "stdio", command: c, args: ["mcp"] }),
  },
  {
    name: "Windsurf",
    mark: "windsurf",
    where: (
      <>
        Paste into <b>~/.codeium/windsurf/mcp_config.json</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Gemini CLI",
    mark: "gemini",
    where: (
      <>
        Paste into <b>~/.gemini/settings.json</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Codex",
    mark: "openai",
    where: (
      <>
        Add to <b>~/.codex/config.toml</b>:
      </>
    ),
    snippet: (c) => `[mcp_servers.hproxy]\ncommand = '${c}'\nargs = ["mcp"]`,
  },
  {
    name: "Zed",
    mark: "zed",
    where: (
      <>
        Zed&rsquo;s settings (<b>zed: open settings file</b>):
      </>
    ),
    snippet: (c) => json("context_servers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Cline",
    mark: "cline",
    where: (
      <>
        Cline, MCP Servers, <b>Configure</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
];

const TOOLS: { name: string; what: string }[] = [
  { name: "Check proxies", what: "Tests a list from this computer: works or not, protocols, anonymity, latency, the exit and its country. Working ones fastest first." },
  { name: "Free proxies", what: "Free public proxies from hproxy.com's live pool, tested here first when asked." },
  { name: "IP lookup", what: "Country, city, time zone and network of any address." },
  { name: "Connect through a proxy", what: "Starts a password-free proxy on 127.0.0.1 that adds the login on the way out, for curl, Playwright or a browser." },
  { name: "Connection status", what: "What is running, through which proxy (password masked), and the traffic." },
  { name: "New IP", what: "Moves to the next proxy of a list or a fresh free exit." },
  { name: "Disconnect", what: "Stops the local proxy." },
  { name: "Open HProxy", what: "Opens this app's window for you, or wakes it in the tray, when your agent has something to show you." },
];

const ASKS = [
  "Check the proxies in proxies.txt and keep the ten fastest elite ones.",
  "Connect me through a free proxy in Germany and tell me which address sites see.",
  "Find me five working SOCKS5 proxies in the United States.",
  "Give me a new IP and tell me where it is.",
];

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="num w-6 shrink-0 pt-0.5 text-[22px] font-extrabold leading-none text-accent-ink">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[15.5px] font-bold text-ink">{title}</p>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

function Block({ text, id, copied, onCopy, big = false }: { text: string; id: string; copied: string | null; onCopy: (id: string, t: string) => void; big?: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Card tone="sunken" pad="tight">
        <pre className={`num max-h-[300px] overflow-auto whitespace-pre-wrap leading-relaxed text-ink ${big ? "text-[13.5px] font-medium" : "text-[13px] font-semibold"}`}>{text}</pre>
      </Card>
      <div>
        <Button variant={big ? "solid" : "soft"} size={big ? "lg" : "sm"} onClick={() => onCopy(id, text)}>
          <Icon.copy className={big ? "h-[18px] w-[18px]" : "h-4 w-4"} />
          {copied === id ? "Copied" : big ? "Copy for my AI agent" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export default function UseWithAi() {
  const [copied, setCopied] = useState<string | null>(null);
  const [cmd, setCmd] = useState("hproxy");
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    void toolCommand()
      .then((c) => c && setCmd(c))
      .catch(() => {});
  }, []);
  const copy = (id: string, text: string) => {
    void copyText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800);
  };
  const setup = SETUPS.find((s) => s.name === pick);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3 px-6 pb-8 pt-1.5 max-sm:px-3">
        <Card pad="roomy">
          <PageHead
            title="Use with AI"
            sub="Your AI agent checks proxies and connects through them, and never sees a password."
            aside={<WorksWith label="Works with every MCP agent" />}
          />

          <div className="mt-7 flex flex-col gap-8">
            <Step n={1} title="Copy this into your AI agent">
              <p className="mb-3 max-w-[76ch] text-[14px] font-medium leading-relaxed text-ink-mute">
                Paste it into the chat. Your agent adds HProxy to its own settings and remembers how to use it. Some apps need a restart to see it.
              </p>
              <Block id="prompt" text={setupPrompt(cmd)} copied={copied} onCopy={copy} big />
            </Step>

            <Step n={2} title="Add this to its memory">
              <p className="mb-3 max-w-[76ch] text-[14px] font-medium leading-relaxed text-ink-mute">
                Already in the text above. On its own, for agents that keep notes between chats (CLAUDE.md, AGENTS.md, rules, memory).
              </p>
              <Block id="memory" text={MEMORY} copied={copied} onCopy={copy} />
            </Step>

            <Step n={3} title="Or set it up yourself">
              <div className="flex flex-wrap gap-1.5">
                {SETUPS.map((s) => (
                  <Chip key={s.name} on={pick === s.name} onClick={() => setPick(pick === s.name ? null : s.name)}>
                    <AgentMark mark={s.mark} size={14} />
                    {s.name}
                  </Chip>
                ))}
              </div>
              {setup && (
                <div key={setup.name} className="rise-in mt-4 flex flex-col gap-3">
                  <p className="max-w-[80ch] text-[14px] font-medium leading-relaxed text-ink-mute">{setup.where}</p>
                  <Block id={setup.name} text={setup.snippet(cmd)} copied={copied} onCopy={copy} />
                </div>
              )}
            </Step>

            <Step n={4} title="Then just ask">
              <div className="grid gap-2 md:grid-cols-2">
                {ASKS.map((q) => (
                  <Card key={q} tone="sunken" pad="tight">
                    <p className="text-[14px] font-semibold leading-relaxed text-ink">“{q}”</p>
                  </Card>
                ))}
              </div>
            </Step>
          </div>
        </Card>

        <Card pad="roomy">
          <BlockTitle name="What your agent can do" value={`${TOOLS.length} tools`} />
          <div className="mt-3 flex flex-col">
            {TOOLS.map((t) => (
              <div key={t.name} className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-[var(--divider)] py-3 first:border-t-0">
                <span className="w-56 shrink-0 text-[14.5px] font-bold text-ink">{t.name}</span>
                {/* min-w-[12rem], not min-w-0: with no floor the text stayed beside the name on a phone, one word per line. */}
                <span className="min-w-[12rem] flex-1 text-[14px] font-medium leading-relaxed text-ink-mute">{t.what}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 max-w-[80ch] text-[13.5px] font-medium leading-relaxed text-ink-mute">
            A mistake is answered with the way out: a wrong tool or argument gets the closest real one and every choice, so even a simple agent finds
            its way. A connection your agent opens is never hidden: it shows under <span className="num font-semibold text-ink">{shellArg(cmd)} status</span>{" "}
            and <span className="num font-semibold text-ink">{shellArg(cmd)} stop</span> ends it.
          </p>
        </Card>
      </div>
    </div>
  );
}

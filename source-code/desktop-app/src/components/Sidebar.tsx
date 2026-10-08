import type { ReactNode } from "react";
import Wordmark from "./Wordmark";
import { openExternal } from "../lib/tauri";

export type View = "checker" | "history" | "settings";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[19px] w-[19px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const NAV: { id: View; label: string; icon: ReactNode }[] = [
  {
    id: "checker",
    label: "Checker",
    icon: (
      <Icon>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="m9 12 2 2 4-4" />
      </Icon>
    ),
  },
  {
    id: "history",
    label: "History",
    icon: (
      <Icon>
        <path d="M3 3v5h5" />
        <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
        <path d="M12 7v5l4 2" />
      </Icon>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
      </Icon>
    ),
  },
];

export default function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col border-r border-hairline bg-surface lg:flex">
      <div className="shrink-0 px-5 pt-6">
        <Wordmark />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-6">
        <p className="px-3.5 pb-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-ink/40">Tools</p>
        <div className="flex flex-col gap-0.5">
          {NAV.map((it) => {
            const active = view === it.id;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => setView(it.id)}
                className={`flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[17px] font-medium transition-colors ${
                  active
                    ? "bg-[#161616] text-white shadow-[0_10px_22px_-12px_rgba(0,0,0,0.55)]"
                    : "text-ink/70 hover:text-ink"
                }`}
              >
                {it.icon}
                <span className="flex-1 truncate text-left">{it.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shrink-0 px-4 pb-5">
        <button
          type="button"
          onClick={() => openExternal("https://hproxy.com/free-proxy-list")}
          className="digi-gradient flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left text-white shadow-[0_18px_40px_-22px_rgba(1,35,104,0.7)] transition-transform hover:-translate-y-0.5"
        >
          <span className="min-w-0">
            <span className="block text-[14px] font-bold">Need proxies?</span>
            <span className="block text-[12px] font-medium text-white/70">Fresh lists on hproxy.com</span>
          </span>
          <span className="text-lg font-bold">→</span>
        </button>
      </div>
    </aside>
  );
}

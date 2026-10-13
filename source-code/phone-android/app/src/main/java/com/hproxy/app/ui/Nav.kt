package com.hproxy.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hproxy.app.engine.PlaceRef

/** The tabs of the nav, the H button in the middle between Proxies and Checker (2026-10-12, the
 *  big VPN apps' shape: Home is the connection itself, the button in the middle connects). Help
 *  is a tab: support one press away; Settings opens from Home. */
enum class Tab { Home, Proxies, Checker, Help }

/** The pages that slide in over the tabs. */
enum class Page {
    /** The connection in detail: your IP and the proxy's, the speed, where, how long, the tools. */
    Connection,
    /** One of your groups: its sessions, to pick the one. */
    Group,
    /** Settings' fraud score checkers. */
    Fraud,
    /** Settings, from the gear on Home. */
    Settings,
    Checks,
    Apps,
    Details,
}

/** The sheets that rise from the bottom (over the nav too). `CheckType`: typing proxies in for
 *  the checker; `Card`: one checked proxy, opened. */
enum class SheetKind { Add, Proxy, Countries, Sort, Judge, CheckType, Card }

/** The Proxies tab's two lists. */
enum class Shelf { Mine, Free }

/** The free list's order (the four of the design rounds). */
enum class SortKey(val title: String, val short: String, val why: String) {
    Fast("Fastest first", "Fastest first", "The shortest round trip in our checks"),
    Fraud("Lowest fraud score first", "Lowest fraud", "The addresses sites trust most"),
    Uptime("Most reliable first", "Most reliable", "The ones that answered our checks most this week"),
    Recent("Checked most recently", "Newest checks", "The newest results of our checks"),
}

/**
 * Where the person is: a tab, the pages slid in over it (a stack, Back takes the top one away),
 * and at most one sheet. The VPN permission and the QR scanner are asked for through
 * MainActivity (`askVpn`, `scan`), which the screens reach through here.
 */
class Nav {
    var tab by mutableStateOf(Tab.Home)
    val pages = mutableStateListOf<Page>()
    var sheet by mutableStateOf<SheetKind?>(null)
    /** Text for Add proxies to read at once (shared from another app, or scanned). */
    var incoming by mutableStateOf<String?>(null)
    /** The proxy the Proxy sheet shows. */
    var opened by mutableStateOf<PlaceRef?>(null)
    /** The checker's card the Card sheet shows (its place in the run). */
    var card by mutableStateOf<Int?>(null)
    /** The group the Group page shows. */
    var group by mutableStateOf<String?>(null)
    /** The Proxies tab: which list (kept for the next start), and the free list's country (null:
     *  all) and order. */
    var shelf by mutableStateOf(Shelf.Free)
        private set
    var country by mutableStateOf<String?>(null)
    var sort by mutableStateOf(SortKey.Fast)

    fun showShelf(s: Shelf) {
        shelf = s
        com.hproxy.app.state.Settings.shelf = s.name
    }

    /** Ask Android for the VPN (its own "connection request" screen), then run `then`. */
    var askVpn: (then: () -> Unit) -> Unit = { it() }
    /** Scan a QR code; the text it carries comes back. */
    var scan: (got: (String) -> Unit) -> Unit = {}
    /** Ask Android to show notifications (13 and later ask the person). */
    var askNotifications: () -> Unit = {}

    /** Another tab: what was open over this one closes. */
    fun go(t: Tab) {
        sheet = null
        pages.clear()
        tab = t
    }

    fun push(p: Page) {
        sheet = null
        pages.remove(p)
        pages.add(p)
    }

    fun open(s: SheetKind) {
        sheet = s
    }

    /** A proxy, opened: its name, its address, every fraud checker's score. A group opens its
     *  page, with its sessions. */
    fun openProxy(ref: PlaceRef) {
        if (ref is PlaceRef.Group) {
            openGroup(ref.id)
            return
        }
        opened = ref
        sheet = SheetKind.Proxy
    }

    fun openGroup(id: String) {
        group = id
        push(Page.Group)
    }

    fun pop(): Boolean {
        if (sheet != null) {
            sheet = null
            return true
        }
        if (pages.isEmpty()) return false
        pages.removeAt(pages.lastIndex)
        return true
    }

    fun close(p: Page) {
        pages.remove(p)
    }
}

package com.hproxy.app.state

/**
 * The connection as a list row reads it: what is being connected or switched to, what is in use
 * since when, whether it stopped answering, and the proxy that just did not answer. It changes only
 * when one of these does, never with the traffic counters, so a long list is not drawn again every
 * second while connected (AppState.conn).
 */
data class Conn(
    val phase: Phase = Phase.Off,
    val running: Boolean = false,
    /** The place in use, by its key ("x:203.0.113.7:8080", "p:<id>", "g:<id>"). */
    val place: String? = null,
    /** For a group, the session in use. */
    val member: Int? = null,
    val since: Long? = null,
    /** In use, and its last two probes failed. */
    val stopped: Boolean = false,
    val failed: Failed? = null,
) {
    /** How the row of `key` (a group's session `member`) stands. */
    fun of(key: String, member: Int? = null): RowState {
        fun same(m: Int?) = member == null || m == null || m == member
        when (val p = phase) {
            is Phase.Switching -> if (p.to.key == key && same(p.member)) return RowState.Busy("Switching")
            is Phase.Connecting -> if (p.to?.key == key && same(p.member)) {
                return RowState.Busy(if (p.step == 0) "Reaching the proxy" else "Checking where you appear")
            }
            else -> {}
        }
        if (phase == Phase.On && running && place == key && (member == null || this.member == member)) {
            return if (stopped) RowState.Bad("Stopped answering") else RowState.On(since)
        }
        val f = failed
        if (phase !is Phase.Connecting && phase !is Phase.Switching && f != null && f.ref.key == key && same(f.member)) {
            return RowState.Bad("Didn't answer")
        }
        return RowState.Idle
    }

    /** Connected through `key` now (switching away from it counts as no longer). */
    fun inUse(key: String, member: Int? = null): Boolean = of(key, member).let { it is RowState.On || (it is RowState.Bad && place == key) }
}

/** A row against the connection: as it is, being connected, in use, or not answering. */
sealed class RowState {
    data object Idle : RowState()
    data class Busy(val words: String) : RowState()
    data class On(val since: Long?) : RowState()
    data class Bad(val words: String) : RowState()
}

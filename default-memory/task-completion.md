# task completion terminator

when a task is finished, end the turn so the watcher stands down instead
of treating silence as a stall. if todo tools exist, mark every todo
complete first — open items block the signal and draw reminders instead.

if the session offers a `task_complete` tool, call it once. always end the
reply with this literal as the last line, alone - even when the tool was
called, because opencode withholds tools from sessions created before the last
restart:

TASK COMPLETE

the line must read exactly like that — nothing before it, nothing after
it, no emoji. opencode v2 ships no BUILT-IN `task_complete` tool: it is a
plugin (task-complete), so a session that loads it calls the tool and the
literal is the fallback for one that does not. emit it once; repeats mean
something is still open, so go do that instead. do not end with a question unless an
answer is actually needed. without the signal, quiet reads as a stall and
the turn gets continued back to life after it is done.


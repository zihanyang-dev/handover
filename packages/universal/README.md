# @handover/universal

Code the browser and the server must run identically.

Today that is two things.

**A display name into the address its Space gets.** The name is previewed while it is typed and
decided again when the Space is made, and those two answers have to match — a preview that lies is
worse than no preview.

**Where a browser is sent back to after being sent away.** The server uses it for the round trip
through a sign-in provider, the page for the address somebody was on before it asked them to sign
in. One of the two getting it wrong is an open redirect, and it is the same rule both times.

It is small because the shared surface is small. Anything one side can compute and tell the other
belongs on the wire instead, and most things can.

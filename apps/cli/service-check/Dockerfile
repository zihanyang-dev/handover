# A machine with a real init, so the unit we generate is judged by the thing that will run it.
#
# systemd needs to be PID 1, which is why this is an image rather than a command: `docker run`
# with `--privileged --cgroupns=host` boots it the same way a small server does.
FROM debian:trixie-slim

RUN apt-get update -qq \
 && apt-get install -y -qq systemd systemd-sysv \
 && rm -rf /var/lib/apt/lists/*

# Stands in for the CLI. What is under test is the unit and the handover to systemd, not what the
# process does — so this one only has to stay up and be killable.
RUN printf '#!/bin/sh\nwhile true; do sleep 1; done\n' > /usr/local/bin/handover-stub \
 && chmod +x /usr/local/bin/handover-stub

# Two ways of stopping, which the unit has to tell apart. Leaving is what the CLI does when its
# machine was taken out of its Space: it is finished, and nothing will make running it again work.
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/handover-left \
 && printf '#!/bin/sh\nexit 1\n' > /usr/local/bin/handover-broke \
 && chmod +x /usr/local/bin/handover-left /usr/local/bin/handover-broke

RUN useradd --create-home mina

CMD ["/sbin/init"]

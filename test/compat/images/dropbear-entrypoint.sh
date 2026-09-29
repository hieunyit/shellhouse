#!/bin/sh
set -e
mkdir -p /home/tester/.ssh
if [ -f /compat/authorized_keys ]; then
  cp /compat/authorized_keys /home/tester/.ssh/authorized_keys
  chown -R tester /home/tester/.ssh && chmod 700 /home/tester/.ssh && chmod 600 /home/tester/.ssh/authorized_keys
fi
# -R: tự tạo host key; -F: chạy nền trước; -E: log ra stderr.
exec dropbear -R -F -E -p 22

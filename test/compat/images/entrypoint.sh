#!/bin/sh
# Chung cho mọi image OpenSSH: user thử nghiệm + host key, rồi chạy sshd với các tuỳ chọn thêm
# (ví dụ server "legacy" chỉ bật thuật toán cũ). Không dùng cho Dropbear.
set -e
if ! id tester >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/sh tester
  else adduser -D -s /bin/sh tester; fi
  echo 'tester:compat-pw' | chpasswd
fi
mkdir -p /home/tester/.ssh /run/sshd /var/run/sshd
if [ -f /compat/authorized_keys ]; then
  cp /compat/authorized_keys /home/tester/.ssh/authorized_keys
  chown -R tester /home/tester/.ssh
  chmod 700 /home/tester/.ssh && chmod 600 /home/tester/.ssh/authorized_keys
fi
ssh-keygen -A >/dev/null 2>&1 || true
# SFTP: chỉ khai báo nếu distro chưa có (OpenSSH cũ báo lỗi khi Subsystem bị khai báo 2 lần).
set --  -o PasswordAuthentication=yes -o AllowTcpForwarding=yes -o PermitRootLogin=no "$@"
if ! grep -qiE '^[[:space:]]*Subsystem[[:space:]]+sftp' /etc/ssh/sshd_config; then
  for p in /usr/libexec/openssh/sftp-server /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server; do
    if [ -x "$p" ]; then set -- "$@" -o "Subsystem=sftp $p"; break; fi
  done
fi
exec /usr/sbin/sshd -D -e "$@"

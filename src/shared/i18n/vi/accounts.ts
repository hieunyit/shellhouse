/** Bản dịch tiếng Việt — Tài khoản dùng chung (Settings → Accounts, ô chọn tài khoản trong form host). */
export const accounts: Readonly<Record<string, string>> = {
  // Service (main)
  '“{value}” is not a valid Windows username': '“{value}” không phải tên đăng nhập Windows hợp lệ',
  '“{value}” is not a valid SSH username': '“{value}” không phải tên đăng nhập SSH hợp lệ',
  'The selected account no longer exists': 'Tài khoản đã chọn không còn nữa',
  'Accounts can only be used by SSH and Remote Desktop hosts':
    'Chỉ host SSH và Remote Desktop mới dùng được tài khoản',
  'The key is used by the account “{name}”': 'Key đang được tài khoản “{name}” dùng',
  'The account no longer exists': 'Tài khoản không còn nữa',
  'There is already an account named “{name}”': 'Đã có tài khoản tên “{name}”',
  'Choose a different account for the hosts': 'Chọn một tài khoản khác cho các host',
  'The key is used by {n} account': 'Key đang được {n} tài khoản dùng',
  'The key is used by {n} accounts': 'Key đang được {n} tài khoản dùng',
  'The account is used by {n} host': 'Tài khoản đang được {n} host dùng',
  'The account is used by {n} hosts': 'Tài khoản đang được {n} host dùng',
  // Kiểm tra dữ liệu (zod)
  'Enter a name for the account': 'Nhập tên cho tài khoản',
  'The name is too long (max 100)': 'Tên quá dài (tối đa 100 ký tự)',
  'The notes are too long (max 2000 characters)': 'Ghi chú quá dài (tối đa 2000 ký tự)',
  'Username must not start with "-"': 'Tên đăng nhập không được bắt đầu bằng "-"',
  // Form host
  'From the account — leave empty to keep it': 'Lấy từ tài khoản — để trống để giữ nguyên',
  'The account “{name}” has no username and the group sets none':
    'Tài khoản “{name}” không có tên đăng nhập và nhóm cũng không đặt',
  Account: 'Tài khoản',
  'Signs in with the account’s username and password.':
    'Đăng nhập bằng tên đăng nhập và mật khẩu của tài khoản.',
  'Tries the account’s SSH key first, then its password.':
    'Thử SSH key của tài khoản trước, rồi tới mật khẩu.',
  'Signs in with the account’s SSH key.': 'Đăng nhập bằng SSH key của tài khoản.',
  'Signs in with the account’s password.': 'Đăng nhập bằng mật khẩu của tài khoản.',
  'Edit account': 'Sửa tài khoản',
  'From the account': 'Lấy từ tài khoản',
  // Sửa tài khoản
  'Saved account {name}': 'Đã lưu tài khoản {name}',
  'Added account {name}': 'Đã thêm tài khoản {name}',
  'Edit account {name}': 'Sửa tài khoản {name}',
  'New account': 'Tài khoản mới',
  'Sign-in details you can pick for any host. Passwords and passphrases are stored encrypted in the vault.':
    'Thông tin đăng nhập chọn được cho mọi host. Mật khẩu và passphrase được mã hoá trong vault.',
  'Production deploy': 'Deploy production',
  'Empty = use the group’s username': 'Trống = dùng tên đăng nhập của nhóm',
  'Remote Desktop only — optional': 'Chỉ cho Remote Desktop — tuỳ chọn',
  'Optional — stored encrypted in the vault': 'Tuỳ chọn — mã hoá trong vault',
  'Remove the saved password': 'Xoá mật khẩu đã lưu',
  'No SSH key': 'Không dùng SSH key',
  'Generate…': 'Tạo key…',
  'Key name': 'Tên key',
  'Passphrase (optional)': 'Passphrase (tuỳ chọn)',
  'Remove the saved passphrase (ask when connecting)': 'Xoá passphrase đã lưu (hỏi khi kết nối)',
  'With both a key and a password, the key is tried first.':
    'Có cả key lẫn mật khẩu thì key được thử trước.',
  'Used by {n} host — changes apply to it right away.':
    'Đang được {n} host dùng — thay đổi áp dụng ngay.',
  'Used by {n} hosts — changes apply to all of them right away.':
    'Đang được {n} host dùng — thay đổi áp dụng ngay cho tất cả.',
  // Ô chọn tài khoản
  '(deleted account)': '(tài khoản đã xoá)',
  'Custom (this host only)': 'Tuỳ chỉnh (chỉ host này)',
  'Search accounts': 'Tìm tài khoản',
  'No matching accounts': 'Không có tài khoản nào khớp',
  '(group username)': '(tên đăng nhập của nhóm)',
  'Enter the username and password or key for this host':
    'Nhập tên đăng nhập và mật khẩu hoặc key riêng cho host này',
  'New account…': 'Tài khoản mới…',
  'Manage accounts…': 'Quản lý tài khoản…',
  // Danh sách tài khoản
  'No password or key': 'Không có mật khẩu hay key',
  'Delete the account “{name}”?': 'Xoá tài khoản “{name}”?',
  'Its password and passphrase are removed from the vault. SSH keys are kept.':
    'Mật khẩu và passphrase của nó bị xoá khỏi vault. SSH key vẫn giữ nguyên.',
  'No accounts yet': 'Chưa có tài khoản nào',
  'Save a username with its password, SSH key and passphrase once, then pick it for any host. Change it here and every host that uses it follows.':
    'Lưu tên đăng nhập cùng mật khẩu, SSH key và passphrase một lần, rồi chọn cho bất kỳ host nào. Sửa ở đây là mọi host dùng nó đều đổi theo.',
  'Not used by any host': 'Chưa host nào dùng',
  'Duplicate {name}': 'Nhân bản {name}',
  'Deleted the account {name}': 'Đã xoá tài khoản {name}',
  'Keep the credentials on each host': 'Giữ thông tin đăng nhập trên từng host',
  'Each host gets its own copy of the username, password and key, and keeps connecting as before.':
    'Mỗi host có bản sao riêng của tên đăng nhập, mật khẩu và key, vẫn kết nối như cũ.',
  'Move the hosts to another account': 'Chuyển các host sang tài khoản khác',
  'There is no other account yet.': 'Chưa có tài khoản nào khác.',
  'The hosts sign in with the account you pick instead.':
    'Các host sẽ đăng nhập bằng tài khoản bạn chọn.',
  Accounts: 'Tài khoản',
  'Shared sign-in details for your hosts.': 'Thông tin đăng nhập dùng chung cho các host.',
  'Used by {n} host': 'Đang được {n} host dùng',
  'Used by {n} hosts': 'Đang được {n} host dùng',
  '{n} host uses this account. Choose what happens to it.':
    '{n} host đang dùng tài khoản này. Chọn cách xử lý host đó.',
  '{n} hosts use this account. Choose what happens to them.':
    '{n} host đang dùng tài khoản này. Chọn cách xử lý các host đó.',
  'Delete account': 'Xoá tài khoản',
  'SSH key (deleted)': 'SSH key (đã xoá)',
  'Pick an account when you create or edit a host instead of typing the username, password and key again. Secrets are stored encrypted in the vault.':
    'Chọn tài khoản khi tạo hoặc sửa host, khỏi gõ lại tên đăng nhập, mật khẩu và key. Secret được mã hoá trong vault.',
  'Used by accounts: {names}': 'Tài khoản đang dùng: {names}',
  'Saved to the account {account} once you are signed in — every host using this account gets it.':
    'Lưu vào tài khoản {account} sau khi đăng nhập thành công — mọi host dùng tài khoản này đều nhận.'
}

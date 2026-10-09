/** Bản dịch tiếng Việt — Module Runbook (và các loại bước K8s / Docker đóng góp cho nó). */
export const runbook: Readonly<Record<string, string>> = {
  // Module Runbook
  Runbooks: 'Runbook',
  'New runbook': 'Runbook mới',
  'Runbook name': 'Tên runbook',
  'Delete runbook': 'Xoá runbook',
  'What is this for? (optional)': 'Dùng để làm gì? (không bắt buộc)',
  'Save the checks you run after a deploy, then run them in one click.':
    'Lưu các bước kiểm tra bạn chạy sau mỗi lần deploy, rồi chạy chỉ bằng một cú nhấp.',
  'The runbook and its steps are deleted. This cannot be undone.':
    'Runbook và các bước của nó bị xoá. Không hoàn tác được.',
  'The runbook no longer exists': 'Runbook này không còn nữa',
  'This runbook no longer exists.': 'Runbook này không còn nữa.',
  'Too many runbooks — delete some first': 'Quá nhiều runbook — hãy xoá bớt trước',
  'A runbook named “{name}” already exists': 'Đã có runbook tên “{name}”',
  '{n} step': '{n} bước',
  '{n} steps': '{n} bước',
  '{n} step, in order': '{n} bước, theo thứ tự',
  '{n} steps, in order': '{n} bước, theo thứ tự',
  'Check the runbook': 'Hãy kiểm tra lại runbook',
  'No steps yet. Add the first check — for example an HTTP health URL.':
    'Chưa có bước nào. Thêm bước kiểm tra đầu tiên — ví dụ một địa chỉ HTTP health.',
  'Add step': 'Thêm bước',
  'Name (optional)': 'Tên (không bắt buộc)',
  'Remove step': 'Xoá bước',
  'Give up after': 'Bỏ cuộc sau',
  seconds: 'giây',
  'Keep going if this step fails': 'Vẫn chạy tiếp nếu bước này lỗi',
  Incomplete: 'Chưa đủ',
  'Last {n} runs': '{n} lần chạy gần nhất',
  'Copy results': 'Chép kết quả',
  'all steps passed': 'mọi bước đều đạt',
  '{failed} failed, {passed} passed': '{failed} lỗi, {passed} đạt',
  '{passed} passed, {failed} failed, {skipped} skipped':
    '{passed} đạt, {failed} lỗi, {skipped} bỏ qua',
  'All {n} step passed': 'Cả {n} bước đều đạt',
  'All {n} steps passed': 'Cả {n} bước đều đạt',
  Passed: 'Đạt',
  Blocked: 'Bị chặn',
  'Run “{name}”?': 'Chạy “{name}”?',
  'Run the failed steps of “{name}” again?': 'Chạy lại các bước lỗi của “{name}”?',
  'Run failed steps again': 'Chạy lại bước lỗi',
  'Stopped — {passed} passed, {failed} failed, {skipped} not run':
    'Đã dừng — {passed} đạt, {failed} lỗi, {skipped} chưa chạy',
  'Collapse step': 'Thu gọn bước',
  'Edit step': 'Sửa bước',
  'Edit all steps': 'Sửa tất cả các bước',
  'Stop the runbook?': 'Dừng runbook?',
  'The runbook is still running. Closing the tab stops it.':
    'Runbook vẫn đang chạy. Đóng tab sẽ dừng nó.',
  'Stop and close': 'Dừng và đóng',
  'This runbook has changes that are not saved.': 'Runbook này có thay đổi chưa lưu.',
  Required: 'Bắt buộc',
  'Default: {value}': 'Mặc định: {value}',
  'Commands do not run on a read-only environment. These steps will be blocked: {steps}':
    'Lệnh không chạy ở môi trường chỉ đọc. Các bước này sẽ bị chặn: {steps}',
  'This runbook reaches {env}. Type its name to run it.':
    'Runbook này chạm tới {env}. Gõ lại tên nó để chạy.',
  'The module for this step is turned off — turn it on in Settings › Modules':
    'Module của bước này đang tắt — bật lại ở Settings › Modules',
  'Unknown step type “{type}”': 'Không biết loại bước “{type}”',
  'This step is incomplete: {what}': 'Bước này chưa đủ: {what}',
  'Skipped — an earlier step failed': 'Bỏ qua — một bước trước đã lỗi',
  'Blocked: commands do not run on the read-only environment {env}':
    'Bị chặn: lệnh không chạy ở môi trường chỉ đọc {env}',

  // Loại bước dựng sẵn
  'HTTP check': 'Kiểm tra HTTP',
  'Command on a server': 'Lệnh trên server',
  'Use {{name}} for a value you type each time you run.':
    'Dùng {{name}} cho giá trị bạn nhập mỗi lần chạy.',
  'Accepted status codes': 'Mã trạng thái chấp nhận',
  'Separated by commas, like 200, 204': 'Cách nhau bằng dấu phẩy, ví dụ 200, 204',
  'Response must contain': 'Phản hồi phải chứa',
  'SSH server': 'Server SSH',
  'Choose a server…': 'Chọn một server…',
  'Runs with sh -c on the server; passes when the exit code is 0. Use {{name}} for a value you type each time.':
    'Chạy bằng sh -c trên server; đạt khi mã thoát là 0. Dùng {{name}} cho giá trị bạn nhập mỗi lần chạy.',
  'Output must contain': 'Đầu ra phải chứa',
  'Optional — checked in what the command prints':
    'Không bắt buộc — kiểm trong những gì lệnh in ra',
  'HTTP (incomplete)': 'HTTP (chưa đủ)',
  'Command (incomplete)': 'Lệnh (chưa đủ)',

  // Kết quả của bước
  'No response': 'Không có phản hồi',
  'HTTP {status} (expected {expected})': 'HTTP {status} (cần {expected})',
  'HTTP {status}, but the response does not contain “{text}”':
    'HTTP {status}, nhưng phản hồi không chứa “{text}”',
  'Exit code {code}': 'Mã thoát {code}',
  'Exit code 0': 'Mã thoát 0',
  'Exit code 0, but the output does not contain “{text}”':
    'Mã thoát 0, nhưng đầu ra không chứa “{text}”',
  'Did not finish within {n} s': 'Chưa xong sau {n} giây',
  'Did not answer within {n} s': 'Không trả lời trong {n} giây',
  'Commands run on an SSH server — pick a host for this step.':
    'Lệnh chạy trên server SSH — hãy chọn host cho bước này.',
  'This is not a valid web address.': 'Đây không phải địa chỉ web hợp lệ.',
  'Only http:// and https:// addresses are checked.': 'Chỉ kiểm tra địa chỉ http:// và https://.',
  'Connection refused (nothing is listening there)':
    'Kết nối bị từ chối (không có gì đang nghe ở đó)',
  'Could not find that host name': 'Không tìm thấy tên máy đó',
  'The TLS certificate is not trusted ({code})': 'Chứng chỉ TLS không được tin cậy ({code})',
  'Could not sign in.': 'Không đăng nhập được.',
  'The session host restarted.': 'Session Host vừa khởi động lại.',

  // Kubernetes: rollout sẵn sàng
  'Kubernetes: rollout is ready': 'Kubernetes: rollout đã sẵn sàng',
  'Cluster context': 'Context cluster',
  Kind: 'Loại',
  'This cluster context is no longer in your kubeconfig.':
    'Context cluster này không còn trong kubeconfig của bạn.',
  'Enter the name of the workload to check.': 'Nhập tên workload cần kiểm tra.',
  'Waiting for the controller to notice the latest change':
    'Đang chờ controller thấy thay đổi mới nhất',
  'No node runs this DaemonSet': 'Không có node nào chạy DaemonSet này',
  '{ready}/{desired} pods ready, {updated} updated':
    '{ready}/{desired} pod sẵn sàng, {updated} đã cập nhật',
  'Scaled to 0 — nothing is running': 'Đã scale về 0 — không có gì đang chạy',
  '{ready}/{desired} replicas ready, {updated} updated':
    '{ready}/{desired} bản sao sẵn sàng, {updated} đã cập nhật',
  'The rollout is paused': 'Rollout đang tạm dừng',

  // Docker: container healthy
  'Docker: container is healthy': 'Docker: container khoẻ',
  'Docker endpoint': 'Endpoint Docker',
  'Container name': 'Tên container',
  Expect: 'Mong đợi',
  'Healthy (health check passes)': 'Healthy (health check đạt)',
  'Enter the name of the container to check.': 'Nhập tên container cần kiểm tra.',
  'No container named “{name}”': 'Không có container tên “{name}”',
  'State: {state}': 'Trạng thái: {state}',
  'Running, health check is still starting': 'Đang chạy, health check vẫn đang khởi động',
  'Running, but the health check fails': 'Đang chạy, nhưng health check lỗi',
  'Running, but this container has no health check — check “running” instead':
    'Đang chạy, nhưng container này không có health check — hãy kiểm tra “running”',
  // Trang Modules
  'Save the checks you run after a deploy and run them in one click':
    'Lưu các bước kiểm tra bạn chạy sau mỗi lần deploy và chạy chỉ bằng một cú nhấp',
  'A runbook is a list of checks you save once and run in one click — after a deploy, before a maintenance window, when something feels wrong. Each step has its own target: check an HTTP health URL, run a command on an SSH server, wait for a Kubernetes Deployment to be ready, or make sure a Docker container is healthy. Steps run in order, stop at the first failure (unless you say otherwise) and show what passed and what did not.\n\nOn a production environment you type the runbook name before it runs, and commands never run on a read-only environment. Output that looks like a secret is hidden before it is shown or kept. Kubernetes and Docker steps appear when those modules are turned on.':
    'Runbook là danh sách các bước kiểm tra bạn lưu một lần rồi chạy chỉ bằng một cú nhấp — sau khi deploy, trước giờ bảo trì, khi thấy có gì đó bất thường. Mỗi bước có đích riêng: kiểm tra một địa chỉ HTTP health, chạy lệnh trên server SSH, chờ Deployment của Kubernetes sẵn sàng, hoặc bảo đảm container Docker khoẻ. Các bước chạy theo thứ tự, dừng ở lỗi đầu tiên (trừ khi bạn chọn khác) và cho thấy bước nào đạt, bước nào không.\n\nTrên môi trường production bạn phải gõ lại tên runbook trước khi chạy, và lệnh không bao giờ chạy trên môi trường chỉ đọc. Đầu ra trông giống bí mật được che trước khi hiện hoặc lưu. Các bước Kubernetes và Docker xuất hiện khi các module đó được bật.',
  'Runs the commands of your runbooks on the SSH servers you pick for a step':
    'Chạy lệnh của runbook trên các server SSH bạn chọn cho từng bước',
  'The web addresses you put in an HTTP check': 'Các địa chỉ web bạn đưa vào bước kiểm tra HTTP',
  // HTTP: method, header, bí mật, TLS
  Headers: 'Header',
  'Add header': 'Thêm header',
  'Remove header': 'Bỏ header',
  'Value — {{name}} allowed': 'Giá trị — dùng được {{name}}',
  'Keep this value secret': 'Giữ giá trị này bí mật',
  'Not a secret': 'Không phải bí mật',
  'Stored encrypted in the vault': 'Đã lưu mã hoá trong vault',
  'Secret value — stored encrypted': 'Giá trị bí mật — được lưu mã hoá',
  'Request body': 'Thân request',
  'Sent as is — set Content-Type in the headers': 'Gửi nguyên văn — đặt Content-Type trong header',
  'HEAD has no response body': 'HEAD không có thân phản hồi',
  'Skip certificate verification (self-signed internal server)':
    'Bỏ kiểm chứng chỉ (server nội bộ tự ký)',
  'The secret value of header {name} is missing — enter it again':
    'Thiếu giá trị bí mật của header {name} — hãy nhập lại',
  'The TLS certificate is not trusted ({code}) — if you trust this server, turn on “Skip certificate verification” for this step':
    'Chứng chỉ TLS không được tin cậy ({code}) — nếu tin server này, bật “Bỏ kiểm chứng chỉ” cho bước này',
  // Nhân bản / xuất / nhập
  '{name} (copy)': '{name} (bản sao)',
  'Created “{name}”': 'Đã tạo “{name}”',
  'Import / export': 'Nhập / xuất',
  'Import runbooks': 'Nhập runbook',
  'Import runbooks…': 'Nhập runbook…',
  'Export all runbooks…': 'Xuất tất cả runbook…',
  'Could not import': 'Không nhập được',
  'Could not import “{name}”': 'Không nhập được “{name}”',
  'Imported {n} runbook': 'Đã nhập {n} runbook',
  'Imported {n} runbooks': 'Đã nhập {n} runbook',
  'No matching server here for: {hosts} — choose one in those steps.':
    'Máy này không có server tương ứng cho: {hosts} — hãy chọn server trong các bước đó.',
  '{n} secret header value is not in the file — enter it again.':
    '{n} giá trị header bí mật không có trong file — hãy nhập lại.',
  '{n} secret header values are not in the file — enter them again.':
    '{n} giá trị header bí mật không có trong file — hãy nhập lại.',
  'This file is too large to be a runbook file.': 'File này quá lớn, không phải file runbook.',
  'This file is not valid JSON.': 'File này không phải JSON hợp lệ.',
  'This is not a Shellhouse runbook file ({issue}).':
    'Đây không phải file runbook của Shellhouse ({issue}).',
  '(step removed since)': '(bước đã bị xoá)'
}

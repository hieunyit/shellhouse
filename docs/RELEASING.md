# Phát hành

## Chuẩn bị một lần (trước bản phát hành đầu tiên)

1. **Repo GitHub** (đã chọn: repo **private** tên `shellhouse` trên tài khoản của bạn).
   - Owner/repo của kênh cập nhật và `homepage` trong gói deb/rpm đều lấy từ repo đang chạy
     workflow, nên không phải sửa file cấu hình nào.
   - Nếu repo private thì người dùng cuối không tải được bản cập nhật. Chuyển repo sang public
     trước khi phát hành cho người khác.
2. **Khoá ký cập nhật Linux (ed25519)**: đã tạo ngày 2026-09-29, xem ADR-0008.
   - Public key đã nhúng trong `src/main/update-keys.ts`; unit test kiểm tra key hợp lệ.
   - Khoá riêng nằm ở `~/.config/shellhouse-release/update-signing-key.pem` (quyền 0600, ngoài
     repo). Chép nội dung file vào secret `UPDATE_SIGNING_KEY` của repo, sau đó **sao lưu ngoại
     tuyến** (trình quản lý mật khẩu). Mất khoá thì bản đã cài không còn nhận cập nhật.
   - Xoay vòng khoá: tạo khoá mới bằng `node scripts/sign-update.mjs --generate`. Phát hành một bản
     chứa cả key cũ và mới, rồi mới đổi secret.
3. **Ký code Windows / macOS** (đã chọn: **beta được phép chưa ký, stable bắt buộc ký**).
   - Tag beta (`vX.Y.Z-beta.N`) khi chưa có secret:
     - Windows: không ký, người dùng thấy cảnh báo SmartScreen.
     - macOS: chỉ ký ad-hoc, không notarize, không tự cập nhật.
     - Release notes tự thêm hướng dẫn cho người thử.
   - Tag stable khi thiếu secret: job dừng lại. electron-updater trên Windows còn kiểm tra bản
     cập nhật có cùng nhà phát hành với bản đang cài.
   - Windows (Authenticode). Nên dùng chứng chỉ OV/EV, hoặc Azure Trusted Signing (rẻ hơn).
     - `WIN_CSC_LINK`: file .pfx dạng base64 (`base64 -w0 cert.pfx`).
     - `WIN_CSC_KEY_PASSWORD`: mật khẩu của file .pfx.
   - macOS: Apple Developer Program (99 USD/năm).
     - `MAC_CSC_LINK`: chứng chỉ "Developer ID Application" (.p12, base64).
     - `MAC_CSC_KEY_PASSWORD`: mật khẩu của file .p12.
     - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: dùng cho notarytool.
4. Bật **Private vulnerability reporting** trong Settings → Security của repo (SECURITY.md trỏ tới).

## Mỗi lần phát hành

- [ ] CI xanh trên `main` (cả 3 OS). Soak hằng đêm gần nhất đạt.
- [ ] `pnpm audit` sạch (CI đã chạy ở mức high); xem thêm các cảnh báo mức moderate.
- [ ] Cập nhật `CHANGELOG.md`: chuyển mục `Unreleased` thành `## [x.y.z] - YYYY-MM-DD`.
- [ ] Tăng `version` trong `package.json` theo SemVer. Bản thử nghiệm dùng `x.y.z-beta.N`: sẽ thành
      pre-release và chỉ kênh beta nhận.
- [ ] Nếu có migration mới: đã test nâng cấp từ DB của bản trước (thư mục dữ liệu thật, không
      chỉ DB rỗng). Migration chỉ được thêm file mới.
- [ ] Commit, tạo tag rồi push:
  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```
- [ ] Workflow `Release` chạy lint, typecheck, test, sau đó build và ký từng OS, ký file kênh Linux,
      smoke test bản đóng gói, rồi tạo **GitHub Release nháp** kèm `SHA256SUMS.txt`.
- [ ] Tải bản nháp về cài thử trên ít nhất một máy mỗi OS:
  - [ ] Khởi động, mở vault, SSH, SFTP.
  - [ ] Windows: xem Properties → Digital Signatures; SmartScreen không chặn.
  - [ ] macOS: `spctl -a -vv /Applications/Shellhouse.app` báo "Notarized Developer ID".
  - [ ] Linux: `dist/latest-linux.yml` có dòng `shellhouseSignature`.
  - [ ] Cập nhật từ bản trước lên bản này qua Settings → Updates.
- [ ] Bấm **Publish** trên bản nháp. Chỉ từ lúc đó người dùng mới nhận bản cập nhật.

## Thu hồi bản lỗi

1. Chuyển release lỗi về Draft (hoặc xoá tài sản `latest*.yml`) để dừng phân phối.
2. Phát hành bản sửa với version **cao hơn**, vì electron-updater không hạ phiên bản trên kênh
   stable.
3. Nếu khoá ký bị lộ: tạo khoá mới, phát hành một bản chứa **cả hai** public key, đổi secret, rồi
   bỏ key cũ ở bản sau (ADR-0008).

## Build cục bộ

```bash
pnpm rebuild:native
pnpm package:dir && pnpm test:package      # bản unpacked + smoke test
pnpm exec electron-builder --linux AppImage deb --publish never
```

Build rpm cần `rpmbuild` (`sudo apt install rpm`). Bản build cục bộ không có `app-update.yml`, nên
tự cập nhật bị tắt. Đó là hành vi đúng.

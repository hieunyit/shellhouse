-- Bucket / thư mục S3 được ghim lên thanh bên (JSON [{bucket, prefix}]) — chỉ là lối tắt, không
-- chứa bí mật.
ALTER TABLE s3_accounts ADD COLUMN pins TEXT NOT NULL DEFAULT '[]';

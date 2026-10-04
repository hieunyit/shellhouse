/**
 * "Copy as command" (thiết kế v0.7): lệnh AWS CLI tương đương cho object / thư mục — profile theo
 * tên tài khoản, `--endpoint-url` cho MinIO / R2 / Wasabi (S3 không phải AWS).
 */
export interface AwsLine {
  id: string
  command: string
}

function q(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Tên profile gợi ý từ tên tài khoản ("MinIO test" → "minio-test"). */
export function profileName(account: string): string {
  return (
    account
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  )
}

export function awsFlags(account: { name: string; endpoint: string; region: string }): string {
  return [
    `--profile ${q(profileName(account.name))}`,
    account.endpoint ? `--endpoint-url ${q(account.endpoint)}` : '',
    account.region ? `--region ${q(account.region)}` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

export function objectCommands(
  account: { name: string; endpoint: string; region: string },
  bucket: string,
  key: string,
  folder: boolean
): AwsLine[] {
  const flags = awsFlags(account)
  const uri = q(`s3://${bucket}/${key}`)
  if (folder)
    return [
      { id: 'list', command: `aws s3 ls ${uri} ${flags}` },
      { id: 'download', command: `aws s3 cp ${uri} . --recursive ${flags}` },
      {
        id: 'sync',
        command: `aws s3 sync ${uri} ./${q(key.replace(/\/$/, '').split('/').pop() ?? 'folder')} ${flags}`
      },
      { id: 'remove', command: `aws s3 rm ${uri} --recursive ${flags}` }
    ]
  return [
    { id: 'download', command: `aws s3 cp ${uri} . ${flags}` },
    {
      id: 'head',
      command: `aws s3api head-object --bucket ${q(bucket)} --key ${q(key)} ${flags}`
    },
    { id: 'presign', command: `aws s3 presign ${uri} --expires-in 3600 ${flags}` },
    { id: 'remove', command: `aws s3 rm ${uri} ${flags}` }
  ]
}

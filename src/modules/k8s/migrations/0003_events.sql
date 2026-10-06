-- Event của cluster đang theo dõi ở Home (cluster chỉ giữ ~1 giờ): giữ trên máy 7 ngày cho tab
-- Timeline. Chỉ thông tin của event (lý do, thông báo, đối tượng) — không có dữ liệu tài nguyên.
CREATE TABLE k8s_events (
  cluster TEXT NOT NULL,
  uid TEXT NOT NULL,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (cluster, uid)
);
CREATE INDEX k8s_events_object ON k8s_events (cluster, namespace, name);
CREATE INDEX k8s_events_last ON k8s_events (last_ts);

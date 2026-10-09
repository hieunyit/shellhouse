/**
 * Đuôi tên miền (TLD) hợp lệ để phân biệt "api.stripe.com" với "config.yaml" / "abc.def" / mật khẩu
 * trông giống tên miền: tên máy thật có nhãn cuối là một TLD đã biết. Gồm TLD chung phổ biến, mọi mã
 * quốc gia 2 chữ (ISO 3166) và vài hậu tố mạng riêng thường dùng trong cluster / công ty.
 */
const GENERIC = `com net org edu gov mil int info biz name pro mobi aero asia coop jobs museum tel travel
app dev cloud ai online site tech store shop blog xyz top club live life world today news media network
systems services solutions digital email link page host cdn api software tools group agency company
team studio design works space website zone academy bank capital center city community computer
consulting directory domains enterprises exchange expert finance financial fund global graphics
health hosting international io management market marketing money partners photography plus
productions properties recipes red rocks run security social support technology tips tv video vip
wiki win work cloudfront amazonaws azure windows googleapis`
const PRIVATE =
  'internal local lan corp intranet home localdomain svc cluster private lab priv k8s kube docker'
const COUNTRY = `ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br
bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es
et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im
in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me
mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph
pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy
sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw`

export const TLDS: ReadonlySet<string> = new Set(
  `${GENERIC} ${PRIVATE} ${COUNTRY}`.split(/\s+/).filter(Boolean)
)

/** Tên có ≥ 2 nhãn và nhãn cuối là TLD đã biết. */
export function hasKnownTld(host: string): boolean {
  const labels = host.toLowerCase().split('.')
  return labels.length >= 2 && TLDS.has(labels[labels.length - 1] ?? '')
}

// app/api/wp/post/route.ts
import { NextResponse } from "next/server"

/**
 * ✅ 통합본 (기존 기능 유지 + 업그레이드)
 * - 1회 요청으로 "V3(장문) 2000자+" HTML 생성 → WP에 draft/발행/예약발행 업로드
 * - Rank Math 메타(제목/설명/포커스키워드/캐노니컬) 지원
 * - 슬러그(slug) 지원
 * - Agoda 페이지에서 og:image 및 호텔 이미지들을 자동 추출(가능한 경우)
 *
 * ENV (Vercel)
 * - API_KEY (또는 INTERNAL_API_KEY) : 요청 헤더 x-api-key 검증
 * - WP_URL : 예) https://hotel.lineuplounge.co.kr
 * - WP_USERNAME : 워드프레스 계정 (예: java0078)
 * - WP_APP_PASSWORD : 워드프레스 Application Password (예: "xxxx xxxx xxxx xxxx xxxx xxxx")
 * - AGODA_AFFILIATE_CID : 아고다 제휴 CID (예: 1959499)  // 없으면 기본값 사용(1959499)
 */

export const runtime = "nodejs" // Buffer/basic auth 사용

type Version = "V1" | "V2" | "V3"
type PublishType = "draft" | "publish" | "future"

type PostRequest = {
  keyword: string
  // 둘 중 하나는 필수 (hotelId=hid)
  hotelId?: string
  hotelUrl?: string

  // 옵션
  version?: Version
  publishType?: PublishType
  publishAt?: string // future일 때 예약시간 ISO
  category?: number

  checkInDate?: string // YYYY-MM-DD
  checkOutDate?: string // YYYY-MM-DD

  // SEO / Rank Math
  slug?: string
  seoTitle?: string
  seoDescription?: string
  focusKeyword?: string
  canonicalUrl?: string
}

function json(status: number, data: any) {
  return NextResponse.json(data, { status })
}

function normalizeVersion(v: any): Version {
  const s = String(v || "").toUpperCase().trim()
  if (s === "V1" || s === "V2" || s === "V3") return s
  return "V3" // ✅ 기본은 V3(장문)
}

function normalizePublishType(v: any): PublishType {
  const s = String(v || "").toLowerCase().trim()
  if (s === "publish" || s === "future" || s === "draft") return s
  return "draft" // ✅ 기본 draft
}

function pickHotelId(inputHotelId?: string, hotelUrl?: string): string | "" {
  if (inputHotelId) return String(inputHotelId).trim()
  if (!hotelUrl) return ""
  const m = hotelUrl.match(/[?&]hid=(\d+)/i)
  if (m?.[1]) return m[1]
  const m2 = hotelUrl.match(/partnersearch\.aspx\?hid=(\d+)/i)
  if (m2?.[1]) return m2[1]
  return ""
}

function buildAffiliateUrl(args: {
  hotelId: string
  hotelUrl?: string
  checkInDate?: string
  checkOutDate?: string
}) {
  const cid = process.env.AGODA_AFFILIATE_CID || "1959499"

  // 사용자가 partnersearch URL을 줬으면, 거기에 cid/checkIn/out만 보강
  if (args.hotelUrl && /agoda\.com\/partners\/partnersearch\.aspx/i.test(args.hotelUrl)) {
    const u = new URL(args.hotelUrl)
    if (!u.searchParams.get("cid")) u.searchParams.set("cid", cid)
    u.searchParams.set("hl", u.searchParams.get("hl") || "ko-kr")
    u.searchParams.set("rooms", u.searchParams.get("rooms") || "1")
    u.searchParams.set("adults", u.searchParams.get("adults") || "2")
    if (args.checkInDate) u.searchParams.set("checkIn", args.checkInDate)
    if (args.checkOutDate) u.searchParams.set("checkOut", args.checkOutDate)
    return u.toString()
  }

  const u = new URL("https://www.agoda.com/partners/partnersearch.aspx")
  u.searchParams.set("hid", args.hotelId)
  u.searchParams.set("cid", cid)
  u.searchParams.set("hl", "ko-kr")
  u.searchParams.set("rooms", "1")
  u.searchParams.set("adults", "2")
  if (args.checkInDate) u.searchParams.set("checkIn", args.checkInDate)
  if (args.checkOutDate) u.searchParams.set("checkOut", args.checkOutDate)
  return u.toString()
}

async function safeFetchText(url: string, opts?: RequestInit): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
        ...(opts?.headers || {}),
      },
      ...opts,
    })
    if (!res.ok) return ""
    return await res.text()
  } catch {
    return ""
  }
}

function extractOgImage(html: string): string {
  const m =
    html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i)
  return m?.[1] || ""
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return (m?.[1] || "").replace(/\s+/g, " ").trim()
}

function extractAgodaImages(html: string, max = 8): string[] {
  const urls = new Set<string>()
  const re =
    /https?:\/\/pix\d+\.agoda\.net\/hotelImages\/[^"'<>\s)]+?\.(?:jpg|jpeg|png)(?:\?[^"'<>\s)]*)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && urls.size < max) {
    urls.add(m[0])
  }
  return Array.from(urls)
}

function cleanHotelNameFromTitle(t: string): string {
  return t
    .replace(/\s*\|\s*Agoda.*$/i, "")
    .replace(/\s*-\s*Agoda.*$/i, "")
    .replace(/\s*\|\s*아고다.*$/i, "")
    .replace(/\s*-\s*아고다.*$/i, "")
    .trim()
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function countNoSpace(text: string): number {
  return text.replace(/\s/g, "").length
}

function ensureMinLength(html: string, minNoSpace = 2000): string {
  const txt = stripHtmlToText(html)
  if (countNoSpace(txt) >= minNoSpace) return html

  const extra = `
<hr/>
<h2>추가로 알면 좋은 팁 (예약 실패 줄이는 디테일)</h2>
<p>리조트/호텔은 ‘같은 날짜’라도 <b>환불 조건</b>, <b>포함 옵션(조식/세금)</b>, <b>객실 타입(전망/침대)</b>에 따라 체감 만족도가 크게 달라집니다.
가격만 보고 결제하면 “조식이 빠져 있었다” “인원이 추가 요금이었다” 같은 실수가 생길 수 있어요. 아래 항목은 체크리스트로 저장해두면 유용합니다.</p>
<ul>
  <li>총액 기준 비교: 세금/봉사료 포함 여부를 반드시 확인</li>
  <li>무료취소 마감 시간: 날짜만 보지 말고 ‘몇 시까지’인지 확인</li>
  <li>체크인 시간: 늦게 도착하는 일정이면 야간 체크인 가능 여부 확인</li>
  <li>침대 타입: 트윈/킹 요청이 가능한지(요청 불가인 곳도 많음)</li>
  <li>리조트 동선: 로비-객실-수영장-조식당 이동이 편한 동인지 후기에서 체크</li>
</ul>

<h2>여행 동선 추천 (가족/커플/효도여행)</h2>
<p>가족여행이라면 숙소 안에서 시간을 보내는 비중이 커서 <b>수영장·키즈존</b>과 <b>조식 혼잡도</b>가 만족도를 좌우합니다.
커플/허니문은 객실 전망과 분위기가 핵심이라 <b>오션뷰/가든뷰 가격 차이</b>가 ‘가치 있는 지출’인지 판단하는 게 좋아요.
부모님 동반이라면 계단/이동거리 같은 동선이 피로도에 영향을 줄 수 있으니 가능한 한 <b>엘리베이터/레스토랑 접근성이 좋은 동</b>을 선택하는 편이 안전합니다.</p>

<h2>마지막 한 줄 결론</h2>
<p>결국 중요한 건 “내 여행 스타일에 맞는 객실/옵션을 고르는 것”입니다. 아래 버튼에서 날짜를 1~2일만 바꿔보며 총액을 비교해보면,
생각보다 더 좋은 조건을 찾을 가능성이 높아요.</p>
`
  return html + extra
}

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501117716987-c8e1ecb2102a?auto=format&fit=crop&w=1200&q=80"

function buildImageBlock(imageUrl: string, alt: string) {
  const src = imageUrl && imageUrl.trim().length > 0 ? imageUrl : FALLBACK_IMAGE

  return `
<div style="text-align:center;margin:18px 0;">
  <img src="${src}" alt="${escapeHtml(alt)}" style="max-width:100%;border-radius:14px;" />
</div>`
}

function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

async function validateImage(url?: string): Promise<string | null> {
  if (!url) return null
  const u = url.trim()
  if (!u) return null

  // ✅ 아고다 default.jpg는 실제로 404가 자주 뜸 → 무조건 버림
  if (u.includes("/default.jpg")) return null

  try {
    // ✅ HEAD 막히는 곳 많아서 GET + Range로 최소 트래픽 확인
    const res = await fetch(u, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
    })

    // ✅ 200/206이면 확정 OK
    if (res.status === 200 || res.status === 206) return u

    // ✅ 403이어도 “이미지는 존재하지만 차단” 케이스가 있음 → 표시용으론 OK 처리(선택)
    if (res.status === 403) return u

    return null
  } catch {
    return null
  }
}
function buildFAQSchema(hotelName: string) {
  const safeName = hotelName || "이 호텔"
  const obj = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `${safeName} 체크인/체크아웃 팁이 있나요?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: "정확한 시간은 예약 페이지 정책이 기준입니다. 늦은 체크인이라면 야간 체크인 가능 여부와 프런트 운영 시간을 확인해두면 좋아요.",
        },
      },
      {
        "@type": "Question",
        name: `${safeName} 조식 포함 옵션이 유리한가요?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: "총액 기준으로 비교하는 것이 가장 안전합니다. 1박당 조식 차액이 크지 않다면 포함 옵션이 편한 경우가 많습니다.",
        },
      },
      {
        "@type": "Question",
        name: "사진과 실제 컨디션이 다를 수 있나요?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "가능합니다. 최근 후기에서 침구/냄새/수압/에어컨 같은 반복 키워드가 어떻게 언급되는지 확인하면 실패 확률을 줄일 수 있습니다.",
        },
      },
    ],
  }
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`
}

function buildHtmlV1(args: {
  keyword: string
  hotelName: string
  affiliateUrl: string
  imageURL?: string
}) {
  const { keyword, hotelName, affiliateUrl, imageURL } = args
  return `
${buildImageBlock(imageURL || "", `${hotelName} 대표 이미지`)}
<h2>${escapeHtml(keyword)} 추천 호텔: ${escapeHtml(hotelName)}</h2>
<p>시간 아끼려고 핵심만 담았어요. 아래 체크리스트만 확인해도 충분해요.</p>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
    👉 아고다 최저가 확인하기
  </a>
</div>

<h3>예약 전 체크리스트</h3>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:6px 0;">조식 포함/불포함 총액 비교</li>
  <li style="margin:6px 0;">무료취소 마감일/시간 확인</li>
  <li style="margin:6px 0;">객실 타입(전망/침대/인원정책) 확인</li>
</ul>

<h3>해시태그</h3>
<p>#${escapeHtml(keyword).replace(/\s+/g, "")} #숙소추천 #예약팁</p>
${buildFAQSchema(hotelName)}
`.trim()
}

function buildHtmlV3(args: {
  keyword: string
  hotelName: string
  affiliateUrl: string
  imageURL?: string
  imageUrls?: string[]
  checkInDate?: string
  checkOutDate?: string
}) {
  const {
    keyword,
    hotelName,
    affiliateUrl,
    imageURL,
    imageUrls = [],
    checkInDate,
    checkOutDate,
  } = args

  const hero = buildImageBlock(imageURL || "", `${hotelName} 대표 이미지`)
  const gallery = (imageUrls || []).slice(0, 4)
  const galleryHtml =
    gallery.length > 0
      ? `
<h2>📸 실제로 많이 보는 이미지 포인트</h2>
<p>호텔은 “사진에서 기대한 느낌”이 중요한 편이라, <b>전경/로비</b>, <b>객실</b>, <b>수영장</b>, <b>조식</b> 컷을 최소 3~4장 정도는 보고 결정하는 게 좋아요.</p>
<div style="display:grid;grid-template-columns:1fr;gap:12px;margin:14px 0;">
  ${gallery
    .map(
      (u, i) =>
        `<img src="${u}" alt="${escapeHtml(hotelName)} 이미지 ${i + 1}" style="max-width:100%;border-radius:14px;" />`
    )
    .join("\n")}
</div>
`
      : ""

  const dateLine =
    checkInDate && checkOutDate ? `${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 확인"

  const html = `
<h1>${escapeHtml(keyword)} 숙소 고민 끝, ${escapeHtml(hotelName)} 핵심 정리</h1>
<p>${escapeHtml(keyword)}로 검색하는 분들이 가장 많이 궁금해하는 건 “가격 대비 실제 만족도”예요.
이 글은 ${escapeHtml(hotelName)}을(를) 예약하기 전에 필요한 판단 기준을 <b>객실·조식·수영장·동선·추가요금</b> 관점에서 정리한 정보형 리뷰 가이드입니다.</p>

${hero}

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    👉 아고다 최저가 확인하기
  </a>
</div>

<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
  <div style="font-weight:900;font-size:16px;margin-bottom:10px;">🏨 기본 정보 한눈에</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.55;">
    <div><b>호텔명</b><br/>${escapeHtml(hotelName)}</div>
    <div><b>핵심 키워드</b><br/>${escapeHtml(keyword)}</div>
    <div><b>추천 일정</b><br/>${escapeHtml(dateLine)}</div>
    <div><b>비교 기준</b><br/>총액(세금/봉사료) + 무료취소</div>
    <div><b>객실 선택</b><br/>전망/침대/인원정책부터 확정</div>
    <div><b>전환 팁</b><br/>1~2일만 바꿔 비교</div>
  </div>
  <div style="margin-top:10px;color:#374151;font-size:13px;">
    “좋다/나쁘다”보다 <b>내 여행 타입에 맞는지</b>가 핵심이에요. 아래 체크리스트대로만 보면 실패 확률이 확 줄어요.
  </div>
</div>

<h2>1️⃣ 객실 구성: 같은 호텔인데 만족도가 갈리는 이유</h2>
<p>대형 호텔/리조트는 객실 타입과 동(건물), 층, 전망에 따라 체감이 달라요.
예를 들어 오션뷰는 ‘뷰값’이 있지만, 실제로는 <b>소음/동선/햇빛 방향</b> 때문에 가든뷰가 더 편한 경우도 있어요.
그래서 예약 전에 “내가 진짜 원하는 것”을 먼저 정하는 게 중요합니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">커플/허니문: 전망(오션뷰) + 프라이버시 우선</li>
  <li style="margin:7px 0;">가족여행: 침대/인원정책 + 키즈 동선 우선</li>
  <li style="margin:7px 0;">효도여행: 이동거리(로비/조식당) + 엘리베이터 우선</li>
</ul>

<h2>2️⃣ 조식·수영장·부대시설: “있다”보다 “운영 조건”이 중요</h2>
<p>후기에서 자주 나오는 변수는 운영시간/혼잡도/예약제/유료 여부예요.
특히 조식은 성수기에는 줄이 생길 수 있어 <b>7시대~8시 초반</b>이 체감 만족도가 높은 편입니다.
수영장은 규모도 중요하지만 <b>키즈존 분리</b>, <b>타월 제공</b>, <b>운영시간</b>이 더 중요할 때가 많아요.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">조식 포함/불포함: “1박 차이”가 아니라 <b>총액</b>으로 비교</li>
  <li style="margin:7px 0;">수영장: 키즈풀/성인풀 분리 + 타월 제공 여부 체크</li>
  <li style="margin:7px 0;">셔틀/스파/키즈클럽: 유료/사전예약 여부 확인</li>
</ul>

${galleryHtml}

<h2>3️⃣ 가격 비교는 이렇게 하면 손해를 줄인다</h2>
<p>성수기에는 하루 차이로 금액이 크게 달라질 수 있어요.
또한 같은 가격이라도 “무료취소” 조건이 있으면 심리적 안정감이 커서, 결과적으로 더 좋은 선택이 되기도 합니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">체크인 날짜를 1~2일 바꿔가며 총액 비교</li>
  <li style="margin:7px 0;">무료취소 마감일(몇 시까지인지) 확인</li>
  <li style="margin:7px 0;">세금/봉사료 포함 여부를 반드시 총액으로 비교</li>
</ul>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#007bff;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    🏨 객실 옵션/총액 비교하기
  </a>
</div>

<h2>4️⃣ 이런 여행자에게 추천</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">가족 여행: 키즈 동선 + 부대시설 활용도가 높은 경우</li>
  <li style="margin:7px 0;">커플/허니문: 전망/분위기/프라이버시를 중시하는 경우</li>
  <li style="margin:7px 0;">휴양 중심: 숙소에서 대부분 해결하고 싶은 일정</li>
</ul>

<h2>5️⃣ 예약 전 체크리스트(최종)</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">무료취소 마감일과 수수료 규정</li>
  <li style="margin:7px 0;">조식 포함 여부 + 총액(세금/봉사료 포함)</li>
  <li style="margin:7px 0;">객실 타입(전망/침대/인원)과 추가요금</li>
  <li style="margin:7px 0;">이동 동선(공항/역/핵심 스팟)과 교통비</li>
</ul>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#28a745;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    📅 예약 페이지 바로가기
  </a>
</div>

<h2>자주 묻는 질문(FAQ)</h2>
<p><b>Q. 체크인/체크아웃 팁이 있나요?</b><br/>A. 정확한 시간은 예약 페이지 정책이 기준이에요. 늦은 체크인이라면 야간 체크인 가능 여부를 먼저 확인해두면 좋아요.</p>
<p><b>Q. 조식 포함 옵션이 유리한가요?</b><br/>A. 총액 기준으로 비교하는 게 정답이에요. 1박당 조식 차액이 크지 않다면 포함 옵션이 편한 경우가 많습니다.</p>
<p><b>Q. 사진과 실제 컨디션이 다를 수 있나요?</b><br/>A. 가능해요. 후기에서 반복 언급되는 침구/냄새/수압/에어컨 같은 키워드를 체크하면 실패 확률을 줄일 수 있어요.</p>

<h2>🏷 해시태그</h2>
<p>#${escapeHtml(keyword).replace(/\s+/g, "")} #숙소추천 #아고다 #호텔예약 #여행팁</p>

${buildFAQSchema(hotelName)}
`.trim()

  return ensureMinLength(html, 2000)
}

function buildHtmlByVersion(params: {
  version: Version
  keyword: string
  hotelName: string
  affiliateUrl: string
  imageURL?: string
  imageUrls?: string[]
  checkInDate?: string
  checkOutDate?: string
}) {
  const { version, ...rest } = params
  if (version === "V1") return buildHtmlV1(rest)
  // ✅ V2/V3는 장문(V3)로 통일(원하면 나중에 분리)
  return buildHtmlV3(rest)
}

async function wpCreatePost(params: {
  title: string
  content: string
  status: PublishType
  category: number
  publishAt?: string
  slug?: string
  seoTitle?: string
  seoDescription?: string
  focusKeyword?: string
  canonicalUrl?: string
}) {
  const WP_URL = process.env.WP_URL
  const WP_USERNAME = process.env.WP_USERNAME
  const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD

  if (!WP_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
    return { error: "Missing WP env vars (WP_URL/WP_USERNAME/WP_APP_PASSWORD)" }
  }

  const endpoint = `${WP_URL.replace(/\/$/, "")}/wp-json/wp/v2/posts`

  // ✅ status 기본은 draft, publish/future만 그대로 허용
  const finalStatus: PublishType =
    params.status === "publish" || params.status === "future" ? params.status : "draft"

  const body: any = {
    title: params.title,
    content: params.content,
    status: finalStatus,
    categories: [Number(params.category || 1)],
  }

  if (params.slug) body.slug = params.slug

  // ✅ 예약 발행
  if (finalStatus === "future") {
    let publishAt = params.publishAt
    if (!publishAt) {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      publishAt = d.toISOString()
    }
    body.date = publishAt
  }

  // ✅ Rank Math 메타
  body.meta = {
    ...(params.seoTitle ? { rank_math_title: params.seoTitle } : {}),
    ...(params.seoDescription ? { rank_math_description: params.seoDescription } : {}),
    ...(params.focusKeyword ? { rank_math_focus_keyword: params.focusKeyword } : {}),
    ...(params.canonicalUrl ? { rank_math_canonical_url: params.canonicalUrl } : {}),
  }

  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64")

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { error: data }
  return data
}

export async function POST(req: Request) {
  // ✅ API KEY 검사 (API_KEY 또는 INTERNAL_API_KEY)
  const expectedKey = process.env.API_KEY || process.env.INTERNAL_API_KEY || ""
  const gotKey = req.headers.get("x-api-key") || ""
  if (expectedKey && gotKey !== expectedKey) {
    return json(401, { error: "Unauthorized" })
  }

  let body: PostRequest
  try {
    body = (await req.json()) as PostRequest
  } catch {
    return json(400, { error: "Invalid JSON" })
  }

  const keyword = String(body.keyword || "").trim()
  const version = normalizeVersion(body.version)
  const publishType = normalizePublishType(body.publishType)
  const category = Number(body.category ?? 1)

  const checkInDate = body.checkInDate ? String(body.checkInDate).trim() : undefined
  const checkOutDate = body.checkOutDate ? String(body.checkOutDate).trim() : undefined

  const slug = body.slug ? String(body.slug).trim() : undefined
  const seoTitle = body.seoTitle ? String(body.seoTitle).trim() : undefined
  const seoDescription = body.seoDescription ? String(body.seoDescription).trim() : undefined
  const focusKeyword = body.focusKeyword ? String(body.focusKeyword).trim() : undefined
  const canonicalUrl = body.canonicalUrl ? String(body.canonicalUrl).trim() : undefined
  const publishAt = body.publishAt ? String(body.publishAt).trim() : undefined

  const hotelId = pickHotelId(body.hotelId, body.hotelUrl)
  if (!keyword) return json(400, { error: "keyword is required" })
  if (!hotelId && !body.hotelUrl) return json(400, { error: "hotelId(or hotelUrl) is required" })

  const affiliateUrl = hotelId
    ? buildAffiliateUrl({ hotelId, hotelUrl: body.hotelUrl, checkInDate, checkOutDate })
    : (body.hotelUrl as string)

  // ✅ Agoda에서 이미지/호텔명 추출 시도 (hotelUrl > affiliateUrl 순서)
  const probeUrl = body.hotelUrl || affiliateUrl
  const html = await safeFetchText(probeUrl)

  const ogImage = html ? extractOgImage(html) : ""
  const imgList = html ? extractAgodaImages(html, 8) : []

  // title에서 호텔명 추정(실패 시 keyword 기반)
  const pageTitle = html ? extractTitle(html) : ""
  const guessedName = cleanHotelNameFromTitle(pageTitle)
  const hotelName = guessedName || `${keyword}`

// 이미지 우선순위: ogImage → imgList[0]  (단, 200 OK만 사용)
const imageURL =
  (await validateImage(ogImage)) ||
  (await validateImage(imgList[0])) ||
  FALLBACK_IMAGE

  const content = buildHtmlByVersion({
    version,
    hotelName,
    keyword,
    affiliateUrl,
    imageURL,
    imageUrls: imgList,
    checkInDate,
    checkOutDate,
  })

  // ✅ 제목 (hid 같은 코드 노출 금지)
  const finalTitle =
    seoTitle ||
    `${keyword} 완벽 가이드: ${hotelName} (객실·조식·수영장·예약팁)`.replace(/\s+/g, " ").trim()

  const wp = await wpCreatePost({
    title: finalTitle,
    content,
    status: publishType, // 내부에서 draft 기본 강제
    category,
    publishAt,
    slug,
    seoTitle,
    seoDescription,
    focusKeyword: focusKeyword || keyword,
    canonicalUrl,
  })

  return json(200, {
    success: true,
    resolved: {
      keyword,
      hotelId,
      affiliateUrl,
      version,
      publishType,
      imageURL,
      imageUrls: imgList,
      slug,
      seoTitle,
      seoDescription,
      focusKeyword: focusKeyword || keyword,
      canonicalUrl,
    },
    wp,
  })
}
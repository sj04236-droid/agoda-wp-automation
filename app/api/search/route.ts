// app/api/search/route.ts
import { NextRequest, NextResponse } from 'next/server'

const SITE_ID = process.env.AGODA_SITE_ID || '1959499'
const API_KEY  = process.env.AGODA_API_KEY  || '24680cfc-3bff-4410-845d-5cb97d854532'
const CID      = process.env.AGODA_AFFILIATE_CID || '1959499'

// CORS 헤더 — WordPress 등 외부 도메인 허용
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// OPTIONS preflight 처리
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// 한글 도시명 → 영문 매핑 (JSON에 영문만 있으므로 변환 필요)
const KR_TO_EN: Record<string, string> = {
  // 국내
  '서울':'seoul','부산':'busan','제주':'jeju','강릉':'gangneung-si',
  '경주':'gyeongju-si','여수':'yeosu-si','인천':'incheon','대구':'daegu',
  '대전':'daejeon','광주':'gwangju metropolitan city','수원':'suwon-si',
  '전주':'jeonju-si','속초':'sokcho-si','통영':'tongyeong-si','거제':'geoje-si',
  '울산':'ulsan','청주':'cheongju-si','평창':'pyeongchang-gun',
  // 일본
  '도쿄':'tokyo','동경':'tokyo','오사카':'osaka','후쿠오카':'fukuoka',
  '교토':'kyoto','삿포로':'sapporo','오키나와':'naha',
  // 태국
  '방콕':'bangkok','푸켓':'phuket','치앙마이':'chiang mai','파타야':'pattaya',
  '코사무이':'koh samui',
  // 베트남
  '다낭':'da nang','하노이':'hanoi','호치민':'ho chi minh city',
  '나트랑':'nha trang','푸꾸옥':'phu quoc',
  // 발리/인도네시아
  '발리':'bali','우붓':'ubud','스미냑':'seminyak','짱구':'canggu',
  // 필리핀
  '세부':'cebu','보라카이':'boracay','마닐라':'manila','엘니도':'el nido',
  // 기타 아시아
  '싱가포르':'singapore','홍콩':'hong kong','타이베이':'taipei',
  '상하이':'shanghai','마카오':'macau','베이징':'beijing',
  // 유럽
  '파리':'paris','런던':'london','로마':'rome','바르셀로나':'barcelona',
  '프라하':'prague','암스테르담':'amsterdam','빈':'vienna','베를린':'berlin',
  // 남태평양
  '괌':'tamuning','사이판':'saipan','하와이':'honolulu','몰디브':'maldives',
  '시드니':'sydney',
}

// GitHub에서 city-ids JSON 로드 (1시간 캐시)
const CITY_JSON_URL = 'https://raw.githubusercontent.com/sj04236-droid/agoda-wp-automation/main/city-ids-worldwide.json'
let cityCache: Record<string, number> | null = null
let cacheTime = 0

async function getCityMap(): Promise<Record<string, number>> {
  if (cityCache && Date.now() - cacheTime < 3600000) return cityCache
  try {
    const res = await fetch(CITY_JSON_URL)
    cityCache  = await res.json()
    cacheTime  = Date.now()
    return cityCache!
  } catch {
    return cityCache || {}
  }
}

async function getCityId(query: string): Promise<{cityId: number, matched: string} | null> {
  const map = await getCityMap()

  // 한글 → 영문 변환
  const q = query.toLowerCase().trim()
  const enQuery = KR_TO_EN[q] || q

  // 1. 영문 변환 후 정확 매칭
  if (map[enQuery]) return { cityId: map[enQuery], matched: enQuery }

  // 2. 원본 정확 매칭
  if (map[q]) return { cityId: map[q], matched: q }

  // 3. 앞부분 매칭
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith(enQuery) || enQuery.startsWith(key)) {
      return { cityId: val, matched: key }
    }
  }

  // 4. 포함 매칭
  for (const [key, val] of Object.entries(map)) {
    if (key.includes(enQuery) || enQuery.includes(key)) {
      return { cityId: val, matched: key }
    }
  }

  return null
}

function getFutureDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query    = (searchParams.get('q') || '').trim()
  const checkIn  = searchParams.get('checkIn')  || getFutureDate(7)
  const checkOut = searchParams.get('checkOut') || getFutureDate(10)
  const adults   = parseInt(searchParams.get('adults') || '2')
  const count    = Math.min(parseInt(searchParams.get('count') || '8'), 30)

  if (!query) {
    return NextResponse.json({ error: 'q 파라미터 필요' }, { status: 400, headers: CORS })
  }

  const result = await getCityId(query)
  if (!result) {
    return NextResponse.json({
      error: `"${query}"을(를) 찾을 수 없습니다. 영문으로도 시도해보세요 (예: Seoul, Tokyo)`,
      results: []
    }, { headers: CORS })
  }

  const { cityId, matched } = result

  try {
    const body = {
      criteria: {
        checkInDate:  checkIn,
        checkOutDate: checkOut,
        cityId,
        additional: {
          currency:           'KRW',
          language:           'ko-kr',
          maxResult:          count,
          sortBy:             'Recommended',
          discountOnly:       false,
          minimumStarRating:  0,
          minimumReviewScore: 0,
          occupancy: { numberOfAdult: adults, numberOfChildren: 0 },
        },
      },
    }

    const res = await fetch('http://affiliateapi7643.agoda.com/affiliateservice/lt_v1', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'Accept-Encoding': 'gzip,deflate',
        'Authorization':   `${SITE_ID}:${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    const data = await res.json()

    if (data.error) {
      return NextResponse.json(
        { error: data.error.message || 'API 오류', cityId, matched, results: [] },
        { headers: CORS }
      )
    }

    const results = (data.results || []).map((h: any) => ({
      hotelId:   h.hotelId,
      name:      h.hotelName,
      stars:     h.starRating,
      score:     typeof h.reviewScore === 'number' ? h.reviewScore.toFixed(1) : '0',
      price:     Math.round(h.dailyRate).toLocaleString('ko-KR'),
      crossed:   h.crossedOutRate > 0 ? Math.round(h.crossedOutRate).toLocaleString('ko-KR') : null,
      discount:  h.discountPercentage > 0 ? Math.round(h.discountPercentage) : null,
      image:     h.imageURL,
      wifi:      h.freeWifi,
      breakfast: h.includeBreakfast,
      url:       (h.landingURL || '').replace(/cid=\d+/, `cid=${CID}`),
    }))

    return NextResponse.json(
      { query, matched, cityId, checkIn, checkOut, adults, count: results.length, results },
      { headers: CORS }
    )

  } catch (e: any) {
    return NextResponse.json(
      { error: e.message, results: [] },
      { status: 500, headers: CORS }
    )
  }
}

// 파일 위치: app/api/search/route.ts
// GitHub에서 city-ids-worldwide.json 읽어서 전세계 도시 검색

import { NextRequest, NextResponse } from 'next/server'

const SITE_ID = process.env.AGODA_SITE_ID || '1959499'
const API_KEY  = process.env.AGODA_API_KEY  || '24680cfc-3bff-4410-845d-5cb97d854532'
const CID      = process.env.AGODA_AFFILIATE_CID || '1959499'

// GitHub raw URL — city-ids-worldwide.json
const CITY_JSON_URL = 'https://raw.githubusercontent.com/sj04236-droid/agoda-wp-automation/main/city-ids-worldwide.json'

// 메모리 캐시 (서버 재시작 전까지 유지 — API 호출 최소화)
let cityCache: Record<string, number> | null = null
let cacheTime = 0

async function getCityMap(): Promise<Record<string, number>> {
  // 1시간 캐시
  if (cityCache && Date.now() - cacheTime < 3600000) return cityCache
  try {
    const res  = await fetch(CITY_JSON_URL, { next: { revalidate: 3600 } })
    cityCache  = await res.json()
    cacheTime  = Date.now()
    return cityCache!
  } catch {
    return cityCache || {}
  }
}

async function getCityId(query: string): Promise<number | null> {
  const map = await getCityMap()
  const q   = query.toLowerCase().trim()

  // 1. 완전 일치
  if (map[q]) return map[q]

  // 2. 부분 일치 (앞에서부터)
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith(q) || q.startsWith(key)) return val
  }

  // 3. 포함 검색
  for (const [key, val] of Object.entries(map)) {
    if (key.includes(q) || q.includes(key)) return val
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
  const query    = searchParams.get('q') || ''
  const checkIn  = searchParams.get('checkIn')  || getFutureDate(7)
  const checkOut = searchParams.get('checkOut') || getFutureDate(10)
  const adults   = parseInt(searchParams.get('adults') || '2')
  const count    = Math.min(parseInt(searchParams.get('count') || '6'), 30)

  if (!query) {
    return NextResponse.json({ error: 'q 파라미터 필요' }, { status: 400 })
  }

  const cityId = await getCityId(query)

  if (!cityId) {
    return NextResponse.json({
      error:   `"${query}" 도시를 찾을 수 없습니다. 다른 이름으로 검색해보세요.`,
      results: []
    })
  }

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
          occupancy: {
            numberOfAdult:    adults,
            numberOfChildren: 0,
          },
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
      return NextResponse.json({ error: data.error.message, cityId, results: [] })
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

    return NextResponse.json({
      query, cityId, checkIn, checkOut, adults,
      count: results.length,
      results,
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' }
    })

  } catch (e: any) {
    return NextResponse.json({ error: e.message, results: [] }, { status: 500 })
  }
}

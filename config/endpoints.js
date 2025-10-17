/**
 * API Configuration and Endpoints
 * Централізована конфігурація для всіх K6 тестів
 */

// Базовий URL API (можна перевизначити через змінну середовища)
export const BASE_URL = __ENV.API_URL || 'http://localhost:4567';

// API Endpoints
export const ENDPOINTS = {
  TRAVEL_PLANS: `${BASE_URL}/api/travel-plans`,
  TRAVEL_PLAN_BY_ID: (id) => `${BASE_URL}/api/travel-plans/${id}`,
  LOCATIONS_FOR_PLAN: (planId) => `${BASE_URL}/api/travel-plans/${planId}/locations`,
  LOCATION_BY_ID: (id) => `${BASE_URL}/api/locations/${id}`,
  HEALTH: `${BASE_URL}/health`,
};

// Типові пороги продуктивності
export const DEFAULT_THRESHOLDS = {
  // 95% запитів повинні виконуватися швидше за 500ms
  'http_req_duration{type:read}': ['p(95)<500'],
  // 95% запитів на запис повинні виконуватися швидше за 1000ms
  'http_req_duration{type:write}': ['p(95)<1000'],
  // 99% всіх запитів повинні виконуватися швидше за 2000ms
  'http_req_duration': ['p(99)<2000'],
  // Рівень помилок повинен бути менше 1%
  'http_req_failed': ['rate<0.01'],
  // Тривалість перевірок (checks)
  'checks': ['rate>0.95'], // 95% перевірок повинні проходити
};

// Конфігурація для smoke тестів
export const SMOKE_THRESHOLDS = {
  'http_req_duration': ['p(95)<1000'],
  'http_req_failed': ['rate<0.05'],
  'checks': ['rate>0.90'],
};

// Конфігурація для stress тестів (більш м'які вимоги)
export const STRESS_THRESHOLDS = {
  'http_req_duration': ['p(95)<2000'],
  'http_req_failed': ['rate<0.05'],
  'checks': ['rate>0.85'],
};

// HTTP заголовки
export const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};

// Часи очікування (think time) між діями користувача
export const THINK_TIME = {
  MIN: 1, // мінімум 1 секунда
  MAX: 3, // максимум 3 секунди
};

// Налаштування retry логіки
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 100, // мілісекунди
};

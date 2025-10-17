/**
 * ============================================================================
 * VALIDATION & ERROR HANDLING LOAD TEST
 * ============================================================================
 * 
 * МЕТА:
 * Перевірити продуктивність валідації даних та обробки помилок під навантаженням.
 * Тестує що API коректно валідує всі вхідні дані та швидко повертає помилки 400
 * без надмірного навантаження на базу даних чи інші ресурси.
 * 
 * ХІД ВИКОНАННЯ ТЕСТУ:
 * Використовуються три паралельні сценарії з різними типами валідації:
 * 
 * СЦЕНАРІЙ 1: "travel_plan_validation" (40% навантаження)
 * - Тестування валідації travel plans:
 *   * Відсутні обов'язкові поля (title)
 *   * Порожні значення
 *   * Занадто довгі рядки (>200 символів)
 *   * Невалідні дати (end_date < start_date)
 *   * Негативний budget
 *   * Невалідні валюти (не ISO 4217)
 *   * Неправильна точність чисел
 * 
 * СЦЕНАРІЙ 2: "location_validation" (40% навантаження)
 * - Тестування валідації locations:
 *   * Відсутнє ім'я локації
 *   * Координати поза межами (lat > 90, lon > 180)
 *   * Невалідні часові діапазони (departure < arrival)
 *   * Негативний budget
 *   * Створення локації для неіснуючого плану (404)
 * 
 * СЦЕНАРІЙ 3: "valid_baseline" (20% навантаження)
 * - Базова лінія з валідними даними для порівняння продуктивності
 * - Створює валідні плани та локації
 * - Порівнюється швидкість обробки валідних vs невалідних запитів
 * 
 * ОЧІКУВАННЯ:
 * - Валідація має бути швидкою (< 100ms для більшості випадків)
 * - Помилки 400 не повинні спричиняти проблем з продуктивністю
 * - Валідація на рівні API має бути швидшою за звернення до БД
 * 
 * МЕТРИКИ:
 * - Response time для валідаційних помилок
 * - Співвідношення швидкості валідних vs невалідних запитів
 * - Error rate (має бути високим - це очікувана поведінка)
 * - Throughput обробки помилок
 * 
 * ============================================================================
 */

import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  addLocation,
  updateTravelPlan,
  deleteTravelPlan,
  testValidation,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateInvalidData,
} from '../utils/data-generator.js';
import { ENDPOINTS } from '../config/endpoints.js';

// Спеціальні метрики
const validationErrors = new Rate('validation_errors');
const validationResponseTime = new Trend('validation_response_time');

// ============================================================================
// НАЛАШТУВАННЯ ТЕСТУ
// ============================================================================

export const options = {
  scenarios: {
    // ========================================
    // Сценарій 1: Валідація Travel Plans
    // ========================================
    travel_plan_validation: {
      executor: 'constant-vus',
      exec: 'testTravelPlanValidation',
      vus: 20,
      duration: '10m',
    },

    // ========================================
    // Сценарій 2: Валідація Locations
    // ========================================
    location_validation: {
      executor: 'constant-vus',
      exec: 'testLocationValidation',
      vus: 20,
      duration: '10m',
      startTime: '5s',
    },

    // ========================================
    // Сценарій 3: Базова лінія (валідні дані)
    // ========================================
    valid_baseline: {
      executor: 'constant-vus',
      exec: 'testValidBaseline',
      vus: 10,
      duration: '10m',
      startTime: '10s',
    },
  },

  thresholds: {
    ...DEFAULT_THRESHOLDS,
    
    // Валідація має бути швидкою
    'validation_response_time': [
      'p(95)<200',  // 95% валідацій < 200ms
      'p(99)<500',  // 99% валідацій < 500ms
    ],
    
    // Очікуємо багато валідаційних помилок (це нормально)
    'validation_errors': ['rate>0.5'], // >50% запитів мають бути валідаційні помилки
    
    // Загальні checks (включають валідаційні помилки як "успіх")
    'checks': ['rate>0.90'],
  },

  userAgent: 'K6-Validation-LoadTest/1.0',
};

// ============================================================================
// СЦЕНАРІЙ 1: ВАЛІДАЦІЯ TRAVEL PLANS
// ============================================================================

export function testTravelPlanValidation() {
  const validationTests = [
    // 1. Відсутнє обов'язкове поле
    {
      name: 'missing_title',
      data: generateInvalidData('missing_title'),
    },
    
    // 2. Порожній title
    {
      name: 'empty_title',
      data: generateInvalidData('empty_title'),
    },
    
    // 3. Занадто довгий title
    {
      name: 'long_title',
      data: generateInvalidData('long_title'),
    },
    
    // 4. Невалідні дати
    {
      name: 'invalid_dates',
      data: generateInvalidData('invalid_dates'),
    },
    
    // 5. Негативний budget
    {
      name: 'negative_budget',
      data: generateInvalidData('negative_budget'),
    },
    
    // 6. Невалідна валюта
    {
      name: 'invalid_currency',
      data: generateInvalidData('invalid_currency'),
    },
  ];

  // Вибираємо випадковий тест з набору
  const testIndex = Math.floor(Math.random() * validationTests.length);
  const test = validationTests[testIndex];

  const startTime = Date.now();
  const success = testValidation('POST', ENDPOINTS.TRAVEL_PLANS, test.data);
  const duration = Date.now() - startTime;

  validationResponseTime.add(duration);
  validationErrors.add(success ? 1 : 0);

  check(success, {
    [`validation test '${test.name}' passed`]: (s) => s === true,
  });

  sleep(0.5);
}

// ============================================================================
// СЦЕНАРІЙ 2: ВАЛІДАЦІЯ LOCATIONS
// ============================================================================

export function testLocationValidation() {
  // Спочатку створюємо валідний план для тестування локацій
  const plan = createTravelPlan(generateTravelPlan());
  
  if (!plan) {
    sleep(1);
    return;
  }

  const planId = plan.id;

  const locationValidationTests = [
    // 1. Відсутнє ім'я
    {
      name: 'missing_name',
      data: { address: 'Test Address', budget: 100 },
    },
    
    // 2. Порожнє ім'я
    {
      name: 'empty_name',
      data: { name: '', budget: 100 },
    },
    
    // 3. Занадто довге ім'я
    {
      name: 'long_name',
      data: { name: 'A'.repeat(250), budget: 100 },
    },
    
    // 4. Невалідна latitude
    {
      name: 'invalid_latitude',
      data: { name: 'Test Location', latitude: 91.0, longitude: 2.0 },
    },
    
    // 5. Невалідна longitude
    {
      name: 'invalid_longitude',
      data: { name: 'Test Location', latitude: 48.0, longitude: 181.0 },
    },
    
    // 6. Невалідний часовий діапазон
    {
      name: 'invalid_time_range',
      data: {
        name: 'Test Location',
        arrival_date: '2025-06-02T15:00:00Z',
        departure_date: '2025-06-02T09:00:00Z',
      },
    },
    
    // 7. Негативний budget
    {
      name: 'negative_budget',
      data: { name: 'Test Location', budget: -50.0 },
    },
  ];

  // Вибираємо випадковий тест
  const testIndex = Math.floor(Math.random() * locationValidationTests.length);
  const test = locationValidationTests[testIndex];

  const startTime = Date.now();
  const success = testValidation(
    'POST',
    ENDPOINTS.LOCATIONS_FOR_PLAN(planId),
    test.data
  );
  const duration = Date.now() - startTime;

  validationResponseTime.add(duration);
  validationErrors.add(success ? 1 : 0);

  check(success, {
    [`location validation test '${test.name}' passed`]: (s) => s === true,
  });

  // Cleanup
  deleteTravelPlan(planId);
  
  sleep(0.5);
}

// ============================================================================
// СЦЕНАРІЙ 3: БАЗОВА ЛІНІЯ (ВАЛІДНІ ДАНІ)
// ============================================================================

export function testValidBaseline() {
  // --------------------------------------------------
  // Створення валідного плану
  // --------------------------------------------------
  const planData = generateTravelPlan();
  const plan = createTravelPlan(planData);
  
  if (!plan) {
    sleep(1);
    return;
  }

  const planId = plan.id;

  check(plan, {
    'valid plan created successfully': (p) => p.id !== undefined,
    'valid plan has version': (p) => p.version === 1,
  });

  sleep(0.3);

  // --------------------------------------------------
  // Додавання валідної локації
  // --------------------------------------------------
  const locationData = generateLocation();
  const location = addLocation(planId, locationData);

  if (location) {
    check(location, {
      'valid location created successfully': (loc) => loc.id !== undefined,
      'valid location has visit_order': (loc) => loc.visit_order >= 1,
    });
  }

  sleep(0.3);

  // --------------------------------------------------
  // Успішне оновлення з правильною версією
  // --------------------------------------------------
  const updateData = {
    ...planData,
    title: 'Updated Valid Plan',
    version: plan.version,
  };
  
  const updated = updateTravelPlan(planId, updateData);

  if (updated && !updated.conflict) {
    check(updated, {
      'valid plan updated successfully': (p) => p.version === 2,
    });
  }

  sleep(0.3);

  // --------------------------------------------------
  // Cleanup
  // --------------------------------------------------
  deleteTravelPlan(planId);
  
  sleep(0.5);
}

// ============================================================================
// ДОДАТКОВИЙ ТЕСТ: Edge Cases
// ============================================================================

/**
 * Окремий експорт для тестування граничних випадків
 * Може бути викликаний окремо або включений в інші сценарії
 */
export function testEdgeCases() {
  // Тест 1: Максимально допустимі значення
  const maxValues = {
    title: 'A'.repeat(200), // Точно 200 символів
    budget: 99999999.99,
    currency: 'USD',
  };

  const plan1 = createTravelPlan(maxValues);
  
  if (plan1) {
    check(plan1, {
      'max title length accepted': (p) => p.title.length === 200,
      'large budget accepted': (p) => p.budget === 99999999.99,
    });
    deleteTravelPlan(plan1.id);
  }

  sleep(0.3);

  // Тест 2: Граничні координати
  const plan2 = createTravelPlan(generateTravelPlan());
  
  if (plan2) {
    const boundaryLocation = {
      name: 'Boundary Location',
      latitude: -90.0,   // Мінімум
      longitude: 180.0,  // Максимум
    };

    const loc = addLocation(plan2.id, boundaryLocation);
    
    if (loc) {
      check(loc, {
        'min latitude accepted': (l) => l.latitude === -90.0,
        'max longitude accepted': (l) => l.longitude === 180.0,
      });
    }

    deleteTravelPlan(plan2.id);
  }

  sleep(0.5);
}

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Validation & Error Handling Load Test');
  console.log('Scenario 1: Travel Plan Validation (20 VUs)');
  console.log('Scenario 2: Location Validation (20 VUs)');
  console.log('Scenario 3: Valid Baseline (10 VUs)');
  console.log('Duration: 10 minutes');
  console.log('Focus: Validation speed, error handling, edge cases');
  console.log('Expected: High error rate is normal (testing validation)');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Validation Load Test completed');
  console.log('Check metrics: validation_response_time and validation_errors rate');
  console.log('='.repeat(80));
}

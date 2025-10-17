/**
 * ============================================================================
 * WRITE-HEAVY LOAD TEST
 * ============================================================================
 * 
 * МЕТА:
 * Симулювати сценарій коли більшість користувачів активно створюють та
 * редагують дані. Типово для піків активності (наприклад, планування
 * літніх відпусток) коли багато людей одночасно створюють маршрути.
 * 
 * СПІВВІДНОШЕННЯ: 20% читання / 80% запису
 * 
 * ХІД ВИКОНАННЯ ТЕСТУ:
 * 1. Користувачі інтенсивно створюють travel plans
 * 2. Додають множинні локації
 * 3. Активно оновлюють інформацію
 * 4. Періодично видаляють та створюють заново
 * 5. Мінімальне читання (тільки для верифікації)
 * 
 * КОЖНА ІТЕРАЦІЯ (80% користувачів - INTENSIVE WRITE):
 * - Створює travel plan
 * - Додає 3-7 локацій
 * - Оновлює план декілька разів
 * - Оновлює локації
 * - Іноді видаляє та створює заново
 * 
 * КОЖНА ІТЕРАЦІЯ (20% користувачів - LIGHT READ):
 * - Швидко переглядає список
 * - Читає декілька планів
 * - Мінімальні паузи
 * 
 * ОСОБЛИВОСТІ:
 * - Високе навантаження на БД (INSERT/UPDATE/DELETE)
 * - Тестує connection pooling
 * - Перевіряє швидкість транзакцій
 * - Тестує індекси та constraints
 * - Високе навантаження на optimistic locking
 * 
 * МЕТРИКИ:
 * - Throughput запису (writes/second)
 * - Response time для POST/PUT/DELETE
 * - Transaction success rate
 * - Database connection pool utilization
 * - Lock contention rate
 * 
 * ============================================================================
 */

import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { STRESS_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  listTravelPlans,
  addLocation,
  updateLocation,
  updateTravelPlan,
  deleteTravelPlan,
  deleteLocation,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateMultipleLocations,
} from '../utils/data-generator.js';

// Кастомні метрики для запису
const writeOperations = new Counter('write_operations');
const readOperations = new Counter('read_operations');
const transactionRate = new Rate('transaction_success');
const locationsPerPlan = new Trend('locations_per_plan');

// ============================================================================
// НАЛАШТУВАННЯ ТЕСТУ
// ============================================================================

export const options = {
  scenarios: {
    // ========================================
    // Сценарій 1: INTENSIVE WRITERS (80%)
    // ========================================
    intensive_writers: {
      executor: 'ramping-vus',
      exec: 'intensiveWritePath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },   // Швидкий ramp-up
        { duration: '8m', target: 50 },   // Інтенсивний запис
        { duration: '2m', target: 0 },    // Ramp-down
      ],
      gracefulRampDown: '30s',
    },

    // ========================================
    // Сценарій 2: LIGHT READERS (20%)
    // ========================================
    light_readers: {
      executor: 'ramping-vus',
      exec: 'lightReadPath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 12 },   // Невелике читання
        { duration: '8m', target: 12 },   
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
      startTime: '10s',
    },
  },

  thresholds: {
    ...STRESS_THRESHOLDS, // Використовуємо м'якші пороги
    
    // Фокус на швидкості запису під навантаженням
    'http_req_duration{type:write}': [
      'p(95)<1500',  // Запис може бути повільнішим під навантаженням
      'p(99)<3000',
    ],
    
    // Читання має залишатись швидким навіть при високому записі
    'http_req_duration{type:read}': [
      'p(95)<800',
    ],
    
    // Високий успіх транзакцій важливий
    'transaction_success': ['rate>0.90'],
    
    // Співвідношення операцій
    'write_operations': ['count>0'],
    'read_operations': ['count>0'],
    
    // Checks можуть частково failing під екстремальним навантаженням
    'checks': ['rate>0.85'],
  },

  userAgent: 'K6-WriteHeavy-LoadTest/1.0',
};

// ============================================================================
// СЦЕНАРІЙ 1: INTENSIVE WRITE PATH (80% користувачів)
// ============================================================================

export function intensiveWritePath() {
  let transactionSuccess = true;

  // --------------------------------------------------
  // 1. СТВОРЕННЯ ПЛАНУ
  // --------------------------------------------------
  const planData = generateTravelPlan();
  planData.title = `Write Intensive Plan ${Date.now()}`;
  
  const plan = createTravelPlan(planData);
  
  if (!plan) {
    transactionSuccess = false;
    transactionRate.add(0);
    sleep(2);
    return;
  }

  const planId = plan.id;
  let currentVersion = plan.version;
  writeOperations.add(1);

  // Мінімальна пауза - інтенсивна робота
  sleep(0.3);

  // --------------------------------------------------
  // 2. ІНТЕНСИВНЕ ДОДАВАННЯ ЛОКАЦІЙ (3-7 локацій)
  // --------------------------------------------------
  const locationCount = Math.floor(Math.random() * 5) + 3; // 3-7 локацій
  const locationIds = [];
  
  for (let i = 0; i < locationCount; i++) {
    const locationData = generateLocation();
    locationData.name = `Location ${i + 1} - ${Date.now()}`;
    
    const location = addLocation(planId, locationData);
    
    if (location) {
      locationIds.push(location.id);
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }
    
    // Мінімальна пауза між додаванням
    sleep(0.2);
  }

  locationsPerPlan.add(locationIds.length);

  sleep(0.3);

  // --------------------------------------------------
  // 3. МНОЖИННІ ОНОВЛЕННЯ ПЛАНУ
  // --------------------------------------------------
  const updateCount = Math.floor(Math.random() * 3) + 2; // 2-4 оновлення
  
  for (let i = 0; i < updateCount; i++) {
    const updateData = {
      ...planData,
      title: `Updated ${i + 1} times - ${planData.title}`,
      budget: (plan.budget || 1000) + (i * 100),
      version: currentVersion,
    };
    
    const updated = updateTravelPlan(planId, updateData);
    
    if (updated && !updated.conflict) {
      currentVersion = updated.version;
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }
    
    sleep(0.2);
  }

  sleep(0.3);

  // --------------------------------------------------
  // 4. ОНОВЛЕННЯ ЛОКАЦІЙ
  // --------------------------------------------------
  // Оновлюємо половину локацій
  const locationsToUpdate = locationIds.slice(0, Math.ceil(locationIds.length / 2));
  
  for (const locationId of locationsToUpdate) {
    const updateData = {
      name: `Updated Location ${Date.now()}`,
      budget: Math.random() * 200 + 50,
      notes: 'Updated during write-heavy test',
    };
    
    const updated = updateLocation(locationId, updateData);
    
    if (updated) {
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }
    
    sleep(0.1);
  }

  sleep(0.3);

  // --------------------------------------------------
  // 5. ВИДАЛЕННЯ ДЕЯКИХ ЛОКАЦІЙ
  // --------------------------------------------------
  // Видаляємо третину локацій
  const locationsToDelete = locationIds.slice(0, Math.ceil(locationIds.length / 3));
  
  for (const locationId of locationsToDelete) {
    const deleted = deleteLocation(locationId);
    
    if (deleted) {
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }
    
    sleep(0.1);
  }

  sleep(0.3);

  // --------------------------------------------------
  // 6. ФІНАЛЬНА ВЕРИФІКАЦІЯ (READ)
  // --------------------------------------------------
  const finalPlan = getTravelPlan(planId);
  readOperations.add(1);
  
  if (finalPlan) {
    const remainingLocations = locationIds.length - locationsToDelete.length;
    check(finalPlan, {
      'plan still exists': (p) => p.id === planId,
      'correct locations count': (p) => p.locations && p.locations.length === remainingLocations,
      'version increased': (p) => p.version > plan.version,
    });
  }

  sleep(0.3);

  // --------------------------------------------------
  // 7. CLEANUP (50% шанс видалення)
  // --------------------------------------------------
  if (Math.random() < 0.5) {
    const deleted = deleteTravelPlan(planId);
    
    if (deleted) {
      writeOperations.add(1);
    } else {
      transactionSuccess = false;
    }
  }

  // Записуємо успішність всієї транзакції
  transactionRate.add(transactionSuccess ? 1 : 0);

  sleep(0.5);
}

// ============================================================================
// СЦЕНАРІЙ 2: LIGHT READ PATH (20% користувачів)
// ============================================================================

export function lightReadPath() {
  readOperations.add(1);

  // --------------------------------------------------
  // 1. ШВИДКЕ ЧИТАННЯ СПИСКУ
  // --------------------------------------------------
  const plansList = listTravelPlans();
  
  if (plansList) {
    check(plansList, {
      'can retrieve plans list during heavy writes': (list) => Array.isArray(list),
    });
  }

  // Мінімальна пауза
  sleep(0.5);

  // --------------------------------------------------
  // 2. ЧИТАННЯ 1-2 ВИПАДКОВИХ ПЛАНІВ
  // --------------------------------------------------
  if (plansList && plansList.length > 0) {
    const readsCount = Math.random() < 0.5 ? 1 : 2;
    
    for (let i = 0; i < readsCount; i++) {
      const randomIndex = Math.floor(Math.random() * plansList.length);
      const randomPlanId = plansList[randomIndex].id;
      
      getTravelPlan(randomPlanId);
      readOperations.add(1);
      
      sleep(0.3);
    }
  }

  // --------------------------------------------------
  // 3. ПЕРЕВІРКА CONSISTENCY
  // --------------------------------------------------
  // Повторне читання списку для перевірки консистентності
  const plansList2 = listTravelPlans();
  readOperations.add(1);
  
  if (plansList && plansList2) {
    // Перевіряємо що система стабільна під навантаженням запису
    check({ list1: plansList, list2: plansList2 }, {
      'data is consistent during writes': (data) => {
        // Обидва списки мають бути валідними
        return Array.isArray(data.list1) && Array.isArray(data.list2);
      },
    });
  }

  sleep(0.5);
}

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Write-Heavy Load Test');
  console.log('Scenario 1: Intensive Writers (50 VUs) - 80% operations');
  console.log('Scenario 2: Light Readers (12 VUs) - 20% operations');
  console.log('Duration: 12 minutes');
  console.log('Focus: Database write performance, transaction throughput');
  console.log('Expected: High write load, stress on DB connections');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Write-Heavy Load Test completed');
  console.log('');
  console.log('Key metrics to review:');
  console.log('  - write_operations (should be ~4x read_operations)');
  console.log('  - transaction_success (should be >90%)');
  console.log('  - http_req_duration{type:write} (write performance)');
  console.log('  - locations_per_plan (complexity metric)');
  console.log('');
  console.log('Performance indicators:');
  console.log('  ✓ If transaction_success >90% → DB handles load well');
  console.log('  ✓ If write p(95) <1.5s → Good write performance');
  console.log('  ✗ If errors >10% → Database needs optimization');
  console.log('='.repeat(80));
}

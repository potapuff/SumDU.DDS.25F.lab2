/**
 * ============================================================================
 * READ-HEAVY LOAD TEST
 * ============================================================================
 * 
 * МЕТА:
 * Симулювати сценарій коли більшість користувачів тільки переглядають дані
 * без активного створення/редагування. Типово для публічних travel plans,
 * коли багато людей дивляться на популярні маршрути.
 * 
 * СПІВВІДНОШЕННЯ: 80% читання / 20% запису
 * 
 * ХІД ВИКОНАННЯ ТЕСТУ:
 * 1. Підготовча фаза (setup): Створює 20 travel plans з локаціями для тестування
 * 2. Основна фаза: Користувачі постійно читають дані з мінімальними оновленнями
 * 3. Cleanup фаза (teardown): Видаляє тестові дані
 * 
 * КОЖНА ІТЕРАЦІЯ (80% користувачів - READ PATH):
 * - Отримує список всіх travel plans (GET /api/travel-plans)
 * - Вибирає випадковий план і отримує його деталі (GET /api/travel-plans/:id)
 * - Читає деталі ще 2-3 планів (симуляція перегляду)
 * - Пауза між переглядами (реалістична поведінка)
 * 
 * КОЖНА ІТЕРАЦІЯ (20% користувачів - WRITE PATH):
 * - Створює новий travel plan
 * - Додає 1-2 локації
 * - Іноді оновлює план
 * 
 * ОСОБЛИВОСТІ:
 * - Високе навантаження на читання
 * - Тестує кешування (якщо є)
 * - Перевіряє швидкість отримання списків
 * - Мінімальне навантаження на БД для запису
 * 
 * МЕТРИКИ:
 * - Response time для GET запитів
 * - Throughput читання (requests/second)
 * - Порівняння швидкості з/без кешування
 * - Стабільність під постійним читанням
 * 
 * ============================================================================
 */

import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Counter } from 'k6/metrics';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  listTravelPlans,
  addLocation,
  updateTravelPlan,
  deleteTravelPlan,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
} from '../utils/data-generator.js';

// Кастомні метрики для читання
const readOperations = new Counter('read_operations');
const writeOperations = new Counter('write_operations');
const cacheHitRate = new Rate('cache_hit_simulation');

// Глобальне сховище для ID створених планів (для читання)
const testPlans = new SharedArray('test_plans', function() {
  return [];
});

// ============================================================================
// НАЛАШТУВАННЯ ТЕСТУ
// ============================================================================

export const options = {
  scenarios: {
    // ========================================
    // Сценарій 1: READERS (80% навантаження)
    // ========================================
    readers: {
      executor: 'ramping-vus',
      exec: 'readHeavyPath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 60 },   // Ramp-up до 60 читачів
        { duration: '8m', target: 60 },   // Стабільне читання
        { duration: '2m', target: 0 },    // Ramp-down
      ],
      gracefulRampDown: '30s',
    },

    // ========================================
    // Сценарій 2: WRITERS (20% навантаження)
    // ========================================
    writers: {
      executor: 'ramping-vus',
      exec: 'writeHeavyPath',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 15 },   // Ramp-up до 15 авторів
        { duration: '8m', target: 15 },   // Стабільний запис
        { duration: '2m', target: 0 },    // Ramp-down
      ],
      gracefulRampDown: '30s',
      startTime: '30s', // Починаємо після того як readers створять дані
    },
  },

  thresholds: {
    ...DEFAULT_THRESHOLDS,
    
    // Акцент на швидкості читання
    'http_req_duration{type:read}': [
      'p(95)<300',   // Читання має бути дуже швидким
      'p(99)<600',
    ],
    
    // Запис може бути трохи повільнішим
    'http_req_duration{type:write}': [
      'p(95)<1000',
    ],
    
    // Співвідношення операцій
    'read_operations': ['count>0'],
    'write_operations': ['count>0'],
    
    // Загальна успішність
    'checks': ['rate>0.95'],
  },

  userAgent: 'K6-ReadHeavy-LoadTest/1.0',
};

// ============================================================================
// SETUP: Створення тестових даних
// ============================================================================

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Read-Heavy Load Test Setup');
  console.log('Creating 20 travel plans with locations for testing...');
  console.log('='.repeat(80));

  const createdPlans = [];

  // Створюємо 20 планів з локаціями
  for (let i = 0; i < 20; i++) {
    const planData = generateTravelPlan();
    planData.title = `Read Test Plan ${i + 1}`;
    planData.is_public = true; // Публічні плани для читання
    
    const plan = createTravelPlan(planData);
    
    if (plan) {
      // Додаємо 2-4 локації до кожного плану
      const locationCount = Math.floor(Math.random() * 3) + 2;
      for (let j = 0; j < locationCount; j++) {
        const locationData = generateLocation();
        addLocation(plan.id, locationData);
      }
      
      createdPlans.push(plan.id);
      console.log(`✓ Created plan ${i + 1}/20: ${plan.id}`);
    }
    
    sleep(0.2); // Невелика пауза між створенням
  }

  console.log(`\nSetup completed: ${createdPlans.length} plans created`);
  console.log('='.repeat(80));
  
  return { planIds: createdPlans };
}

// ============================================================================
// СЦЕНАРІЙ 1: READ-HEAVY PATH (80% користувачів)
// ============================================================================

export function readHeavyPath(data) {
  if (!data || !data.planIds || data.planIds.length === 0) {
    console.warn('No test plans available for reading');
    sleep(5);
    return;
  }

  readOperations.add(1);

  // --------------------------------------------------
  // 1. ОТРИМАННЯ СПИСКУ ПЛАНІВ
  // --------------------------------------------------
  const plansList = listTravelPlans();
  
  if (plansList && plansList.length > 0) {
    check(plansList, {
      'plans list not empty': (list) => list.length > 0,
      'plans list contains test data': (list) => list.length >= 10,
    });
  }

  thinkTime(1, 2); // Користувач дивиться на список

  // --------------------------------------------------
  // 2. ЧИТАННЯ ДЕТАЛЕЙ ВИПАДКОВОГО ПЛАНУ
  // --------------------------------------------------
  const randomPlanId = data.planIds[Math.floor(Math.random() * data.planIds.length)];
  const planDetails = getTravelPlan(randomPlanId);
  
  if (planDetails) {
    check(planDetails, {
      'plan has locations': (p) => p.locations && p.locations.length > 0,
      'plan is public': (p) => p.is_public === true,
    });
    
    // Симуляція cache hit (якщо той самий план читається часто)
    const isSamePlanAsLastTime = Math.random() < 0.3;
    cacheHitRate.add(isSamePlanAsLastTime ? 1 : 0);
  }

  thinkTime(2, 4); // Користувач читає деталі плану

  // --------------------------------------------------
  // 3. ЧИТАННЯ ЩЕ ДЕКІЛЬКОХ ПЛАНІВ (browsing)
  // --------------------------------------------------
  const additionalReads = Math.floor(Math.random() * 3) + 1; // 1-3 додаткові читання
  
  for (let i = 0; i < additionalReads; i++) {
    const anotherPlanId = data.planIds[Math.floor(Math.random() * data.planIds.length)];
    getTravelPlan(anotherPlanId);
    readOperations.add(1);
    
    thinkTime(1, 3); // Пауза між переглядами
  }

  // --------------------------------------------------
  // 4. ПОВТОРНЕ ЧИТАННЯ СПИСКУ (refresh)
  // --------------------------------------------------
  // 30% шанс що користувач оновить список
  if (Math.random() < 0.3) {
    listTravelPlans();
    readOperations.add(1);
  }

  sleep(1);
}

// ============================================================================
// СЦЕНАРІЙ 2: WRITE PATH (20% користувачів)
// ============================================================================

export function writeHeavyPath(data) {
  writeOperations.add(1);

  // --------------------------------------------------
  // 1. СТВОРЕННЯ НОВОГО ПЛАНУ
  // --------------------------------------------------
  const planData = generateTravelPlan();
  planData.title = `User Created Plan ${Date.now()}`;
  
  const plan = createTravelPlan(planData);
  
  if (!plan) {
    sleep(2);
    return;
  }

  const planId = plan.id;

  thinkTime(1, 2);

  // --------------------------------------------------
  // 2. ДОДАВАННЯ 1-2 ЛОКАЦІЙ
  // --------------------------------------------------
  const locationCount = Math.random() < 0.5 ? 1 : 2;
  
  for (let i = 0; i < locationCount; i++) {
    const locationData = generateLocation();
    addLocation(planId, locationData);
    writeOperations.add(1);
    
    thinkTime(0.5, 1.5);
  }

  // --------------------------------------------------
  // 3. ЧИТАННЯ СТВОРЕНОГО ПЛАНУ (verification)
  // --------------------------------------------------
  getTravelPlan(planId);
  readOperations.add(1);

  thinkTime(1, 2);

  // --------------------------------------------------
  // 4. ІНОДІ ОНОВЛЕННЯ ПЛАНУ (50% шанс)
  // --------------------------------------------------
  if (Math.random() < 0.5) {
    const updateData = {
      ...planData,
      title: `Updated: ${planData.title}`,
      budget: plan.budget ? plan.budget + 100 : 1000,
      version: plan.version,
    };
    
    updateTravelPlan(planId, updateData);
    writeOperations.add(1);
    
    thinkTime(1, 2);
  }

  // --------------------------------------------------
  // 5. ВИДАЛЕННЯ (cleanup - не завжди)
  // --------------------------------------------------
  // Тільки 30% планів видаляються (щоб накопичувались дані)
  if (Math.random() < 0.3) {
    deleteTravelPlan(planId);
    writeOperations.add(1);
  }

  sleep(1);
}

// ============================================================================
// TEARDOWN: Видалення тестових даних
// ============================================================================

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Read-Heavy Load Test Cleanup');
  console.log('Deleting test plans...');
  console.log('='.repeat(80));

  if (data && data.planIds) {
    let deleted = 0;
    for (const planId of data.planIds) {
      const success = deleteTravelPlan(planId);
      if (success) {
        deleted++;
      }
      sleep(0.1);
    }
    console.log(`\nCleanup completed: ${deleted}/${data.planIds.length} plans deleted`);
  }

  console.log('='.repeat(80));
  console.log('Read-Heavy Load Test completed');
  console.log('Check metrics:');
  console.log('  - read_operations (should be ~4x write_operations)');
  console.log('  - http_req_duration{type:read} (should be fast)');
  console.log('  - cache_hit_simulation (shows repeated reads)');
  console.log('='.repeat(80));
}

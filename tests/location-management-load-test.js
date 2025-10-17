/**
 * ============================================================================
 * LOCATION MANAGEMENT LOAD TEST
 * ============================================================================
 * 
 * МЕТА:
 * Перевірити продуктивність операцій з локаціями в travel plans під навантаженням.
 * Тестує створення, оновлення та видалення локацій, а також перевірку автоматичного
 * впорядкування (auto-ordering) локацій за visit_order.
 * 
 * ХІД ВИКОНАННЯ ТЕСТУ:
 * 1. Ramp-up фаза (2 хвилини): Поступове збільшення від 0 до 30 користувачів
 * 2. Steady state (8 хвилин): Стабільне навантаження з 30 користувачами
 * 3. Ramp-down фаза (2 хвилини): Плавне зменшення навантаження до 0
 * 
 * КОЖНА ІТЕРАЦІЯ ТЕСТУ:
 * - Створює travel plan
 * - Додає 3 локації послідовно (перевірка auto-ordering: 1, 2, 3)
 * - Отримує план і перевіряє що всі локації присутні у правильному порядку
 * - Оновлює одну з локацій (змінює назву, бюджет, нотатки)
 * - Видаляє одну локацію
 * - Перевіряє що після видалення залишилось 2 локації
 * - Видаляє весь plan (каскадне видалення локацій)
 * 
 * ОСОБЛИВОСТІ:
 * - Тестує роботу з координатами (latitude/longitude)
 * - Перевіряє автоматичне присвоєння visit_order
 * - Тестує правильність зв'язків (travel_plan_id)
 * - Перевіряє каскадне видалення
 * 
 * МЕТРИКИ:
 * - Response time для операцій з локаціями
 * - Успішність auto-ordering
 * - Throughput операцій з локаціями
 * - Error rate
 * 
 * ============================================================================
 */

import { check, sleep } from 'k6';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  addLocation,
  updateLocation,
  deleteLocation,
  deleteTravelPlan,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateLocationWithDates,
} from '../utils/data-generator.js';

// ============================================================================
// НАЛАШТУВАННЯ ТЕСТУ
// ============================================================================

export const options = {
  stages: [
    { duration: '2m', target: 30 },  // Ramp-up до 30 користувачів
    { duration: '8m', target: 30 },  // Стабільне навантаження
    { duration: '2m', target: 0 },   // Ramp-down
  ],

  thresholds: {
    ...DEFAULT_THRESHOLDS,
    
    // Спеціальні пороги для операцій з локаціями
    'http_req_duration{type:write}': ['p(95)<1200'],
    'http_req_duration{type:read}': ['p(95)<600'],
    
    // Перевірки мають проходити успішно
    'checks': ['rate>0.95'],
  },

  userAgent: 'K6-LocationManagement-LoadTest/1.0',
};

// ============================================================================
// ОСНОВНИЙ СЦЕНАРІЙ ТЕСТУ
// ============================================================================

export default function () {
  // --------------------------------------------------
  // 1. ПІДГОТОВКА: Створення travel plan
  // --------------------------------------------------
  const planData = generateTravelPlan();
  const plan = createTravelPlan(planData);
  
  if (!plan) {
    console.error('Failed to create travel plan for location test');
    return;
  }

  const planId = plan.id;
  thinkTime(0.5, 1);

  // --------------------------------------------------
  // 2. ДОДАВАННЯ ПЕРШОЇ ЛОКАЦІЇ
  // --------------------------------------------------
  const location1Data = {
    name: 'Eiffel Tower',
    address: 'Champ de Mars, 5 Avenue Anatole France, 75007 Paris',
    latitude: 48.8584,
    longitude: 2.2945,
    budget: 25.00,
    notes: 'Visit in the morning for fewer crowds',
  };

  const location1 = addLocation(planId, location1Data);
  
  if (!location1) {
    console.error('Failed to add first location');
    deleteTravelPlan(planId);
    return;
  }

  // Перевірка автоматичного порядку
  check(location1, {
    'location1 has visit_order 1': (loc) => loc.visit_order === 1,
    'location1 linked to plan': (loc) => loc.travel_plan_id === planId,
  });

  thinkTime(0.5, 1.5);

  // --------------------------------------------------
  // 3. ДОДАВАННЯ ДРУГОЇ ЛОКАЦІЇ
  // --------------------------------------------------
  const location2Data = generateLocationWithDates(31);
  location2Data.name = 'Louvre Museum';
  
  const location2 = addLocation(planId, location2Data);
  
  if (!location2) {
    console.error('Failed to add second location');
    deleteTravelPlan(planId);
    return;
  }

  check(location2, {
    'location2 has visit_order 2': (loc) => loc.visit_order === 2,
  });

  thinkTime(0.5, 1.5);

  // --------------------------------------------------
  // 4. ДОДАВАННЯ ТРЕТЬОЇ ЛОКАЦІЇ
  // --------------------------------------------------
  const location3Data = {
    name: 'Arc de Triomphe',
    budget: 12.00,
  };
  
  const location3 = addLocation(planId, location3Data);
  
  if (!location3) {
    console.error('Failed to add third location');
    deleteTravelPlan(planId);
    return;
  }

  check(location3, {
    'location3 has visit_order 3': (loc) => loc.visit_order === 3,
  });

  thinkTime(1, 2);

  // --------------------------------------------------
  // 5. ПЕРЕВІРКА ПЛАНУ З УСІМА ЛОКАЦІЯМИ
  // --------------------------------------------------
  const planWithLocations = getTravelPlan(planId);
  
  if (!planWithLocations) {
    console.error('Failed to retrieve plan with locations');
    deleteTravelPlan(planId);
    return;
  }

  check(planWithLocations, {
    'plan has 3 locations': (p) => p.locations && p.locations.length === 3,
    'locations ordered correctly': (p) => {
      if (!p.locations || p.locations.length !== 3) return false;
      return (
        p.locations[0].visit_order === 1 &&
        p.locations[1].visit_order === 2 &&
        p.locations[2].visit_order === 3
      );
    },
  });

  thinkTime(1, 2);

  // --------------------------------------------------
  // 6. ОНОВЛЕННЯ ЛОКАЦІЇ
  // --------------------------------------------------
  const updateData = {
    name: 'Eiffel Tower (Night Visit)',
    budget: 30.00,
    notes: 'Amazing night illumination',
  };
  
  const updatedLocation = updateLocation(location1.id, updateData);
  
  if (updatedLocation) {
    check(updatedLocation, {
      'location name updated': (loc) => loc.name === 'Eiffel Tower (Night Visit)',
      'location budget updated': (loc) => loc.budget === 30.00,
      'location notes updated': (loc) => loc.notes === 'Amazing night illumination',
    });
  }

  thinkTime(1, 1.5);

  // --------------------------------------------------
  // 7. ВИДАЛЕННЯ ЛОКАЦІЇ
  // --------------------------------------------------
  const deleted = deleteLocation(location2.id);
  
  thinkTime(0.5, 1);

  // --------------------------------------------------
  // 8. ПЕРЕВІРКА ПІСЛЯ ВИДАЛЕННЯ
  // --------------------------------------------------
  const planAfterDelete = getTravelPlan(planId);
  
  if (planAfterDelete) {
    check(planAfterDelete, {
      'plan has 2 locations after delete': (p) => p.locations && p.locations.length === 2,
    });
  }

  thinkTime(0.5, 1);

  // --------------------------------------------------
  // 9. CLEANUP: Видалення плану (каскадне видалення локацій)
  // --------------------------------------------------
  deleteTravelPlan(planId);

  sleep(1);
}

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Location Management Load Test');
  console.log('Focus: Auto-ordering, CRUD operations on locations');
  console.log('Target: 30 concurrent users');
  console.log('Duration: 12 minutes');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Location Management Load Test completed');
  console.log('='.repeat(80));
}

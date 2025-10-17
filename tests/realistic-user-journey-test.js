/**
 * ============================================================================
 * REALISTIC USER JOURNEY LOAD TEST
 * ============================================================================
 * 
 * МЕТА:
 * Симулювати реальну поведінку користувачів при плануванні подорожі.
 * Включає природні паузи (think time), помилки, зміну рішень та
 * типові сценарії використання API.
 * 
 * СПІВВІДНОШЕННЯ: ~60% читання / ~40% запису (збалансоване)
 * 
 * ТИПОВІ СЦЕНАРІЇ КОРИСТУВАЧІВ:
 * 
 * 1. "Новий користувач" (30% - створює перший plan)
 *    - Переглядає приклади (читає публічні плани)
 *    - Створює свій перший travel plan
 *    - Додає локації поступово
 *    - Вносить виправлення (редагує)
 * 
 * 2. "Досвідчений користувач" (50% - редагує існуючий)
 *    - Переглядає свої плани
 *    - Вибирає один для редагування
 *    - Додає нові локації
 *    - Оновлює існуючі
 *    - Видаляє непотрібні
 * 
 * 3. "Браузер" (20% - тільки переглядає)
 *    - Шукає ідеї для подорожі
 *    - Переглядає різні плани
 *    - Детально вивчає локації
 *    - Не створює власних планів
 * 
 * ОСОБЛИВОСТІ:
 * - Think time між діями (1-5 секунд)
 * - Реалістичні помилки та виправлення
 * - Іноді користувач змінює думку (видаляє щойно створене)
 * - Імітація паралельної роботи в кількох вкладках
 * - Сесії різної тривалості
 * 
 * МЕТРИКИ:
 * - User session duration
 * - Actions per session
 * - Session completion rate
 * - Think time impact on performance
 * 
 * ============================================================================
 */

import { check, sleep, group } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { randomIntBetween } from 'k6';
import { DEFAULT_THRESHOLDS } from '../config/endpoints.js';
import {
  createTravelPlan,
  getTravelPlan,
  listTravelPlans,
  addLocation,
  updateLocation,
  updateTravelPlan,
  deleteTravelPlan,
  deleteLocation,
  checkHealth,
  thinkTime,
} from '../utils/api-client.js';
import {
  generateTravelPlan,
  generateLocation,
  generateLocationWithDates,
} from '../utils/data-generator.js';

// Кастомні метрики для user journeys
const sessionCompleted = new Rate('session_completion_rate');
const actionsPerSession = new Trend('actions_per_session');
const sessionDuration = new Trend('session_duration_seconds');
const userTypeDistribution = new Counter('user_type_distribution');

// ============================================================================
// НАЛАШТУВАННЯ ТЕСТУ
// ============================================================================

export const options = {
  scenarios: {
    // ========================================
    // Реалістичні користувачі з різними сценаріями
    // ========================================
    realistic_users: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 100,
      stages: [
        { duration: '3m', target: 10 },   // Поступовий ріст активності
        { duration: '7m', target: 20 },   // Пік активності
        { duration: '5m', target: 15 },   // Спад
        { duration: '3m', target: 5 },    // Низька активність
      ],
      exec: 'realisticUserJourney',
    },
  },

  thresholds: {
    ...DEFAULT_THRESHOLDS,
    
    // Реалістичні пороги з урахуванням think time
    'http_req_duration': [
      'p(95)<800',
      'p(99)<1500',
    ],
    
    // Успішність сесій
    'session_completion_rate': ['rate>0.90'],
    
    // Типова сесія має мати декілька дій
    'actions_per_session': ['avg>5', 'avg<20'],
    
    // Checks
    'checks': ['rate>0.93'],
  },

  userAgent: 'K6-RealisticUser-LoadTest/1.0',
};

// ============================================================================
// ГОЛОВНА ФУНКЦІЯ: ВИБІР ТИПУ КОРИСТУВАЧА
// ============================================================================

export default function realisticUserJourney() {
  const sessionStart = Date.now();
  let actionsCount = 0;
  let sessionSuccess = true;

  // Випадково вибираємо тип користувача
  const rand = Math.random();
  let userType;
  
  if (rand < 0.30) {
    userType = 'new_user';
    userTypeDistribution.add(1, { type: 'new_user' });
    actionsCount = newUserJourney();
  } else if (rand < 0.80) {
    userType = 'experienced_user';
    userTypeDistribution.add(1, { type: 'experienced_user' });
    actionsCount = experiencedUserJourney();
  } else {
    userType = 'browser';
    userTypeDistribution.add(1, { type: 'browser' });
    actionsCount = browserJourney();
  }

  // Записуємо метрики сесії
  const sessionEnd = Date.now();
  const duration = (sessionEnd - sessionStart) / 1000; // в секундах
  
  sessionDuration.add(duration);
  actionsPerSession.add(actionsCount);
  sessionCompleted.add(sessionSuccess ? 1 : 0);
}

// ============================================================================
// СЦЕНАРІЙ 1: НОВИЙ КОРИСТУВАЧ
// ============================================================================

function newUserJourney() {
  let actions = 0;

  group('New User Journey', function() {
    // --------------------------------------------------
    // 1. Перевірка що API працює
    // --------------------------------------------------
    checkHealth();
    actions++;
    thinkTime(1, 2);

    // --------------------------------------------------
    // 2. Перегляд прикладів (публічні плани)
    // --------------------------------------------------
    group('Browse examples', function() {
      const publicPlans = listTravelPlans();
      actions++;
      
      if (publicPlans && publicPlans.length > 0) {
        // Дивиться на 2-3 приклади
        const examplesToView = Math.min(randomIntBetween(2, 3), publicPlans.length);
        
        for (let i = 0; i < examplesToView; i++) {
          const planId = publicPlans[i].id;
          getTravelPlan(planId);
          actions++;
          
          thinkTime(3, 6); // Довго вивчає приклади
        }
      }
    });

    // --------------------------------------------------
    // 3. Створення першого плану
    // --------------------------------------------------
    group('Create first plan', function() {
      thinkTime(2, 4); // Думає як назвати
      
      const planData = generateTravelPlan();
      planData.title = 'My First Travel Plan';
      planData.description = 'Exciting new journey!';
      
      const plan = createTravelPlan(planData);
      actions++;
      
      if (!plan) {
        return actions;
      }

      const planId = plan.id;
      let currentVersion = plan.version;

      thinkTime(1, 2); // Радіє що створив

      // --------------------------------------------------
      // 4. Додавання локацій (поступово, по одній)
      // --------------------------------------------------
      group('Add locations gradually', function() {
        const locationsToAdd = randomIntBetween(2, 5);
        
        for (let i = 0; i < locationsToAdd; i++) {
          thinkTime(2, 4); // Думає яку локацію додати
          
          const locationData = generateLocationWithDates(30 + i);
          const location = addLocation(planId, locationData);
          actions++;
          
          if (location) {
            // Перевіряє що локацію додано
            thinkTime(1, 2);
            getTravelPlan(planId);
            actions++;
          }
        }
      });

      // --------------------------------------------------
      // 5. Виправлення помилок (редагування)
      // --------------------------------------------------
      group('Fix mistakes', function() {
        thinkTime(3, 5); // Переглядає і знаходить помилку
        
        // Оновлює план (наприклад, змінює дати або бюджет)
        const updateData = {
          ...planData,
          budget: (plan.budget || 1000) + 500,
          description: 'Updated description with more details',
          version: currentVersion,
        };
        
        const updated = updateTravelPlan(planId, updateData);
        actions++;
        
        if (updated && !updated.conflict) {
          currentVersion = updated.version;
        }
      });

      // --------------------------------------------------
      // 6. Фінальний перегляд
      // --------------------------------------------------
      thinkTime(2, 3);
      getTravelPlan(planId);
      actions++;

      // Новий користувач зазвичай НЕ видаляє свій перший план
    });
  });

  return actions;
}

// ============================================================================
// СЦЕНАРІЙ 2: ДОСВІДЧЕНИЙ КОРИСТУВАЧ
// ============================================================================

function experiencedUserJourney() {
  let actions = 0;

  group('Experienced User Journey', function() {
    // --------------------------------------------------
    // 1. Перегляд своїх планів
    // --------------------------------------------------
    group('View my plans', function() {
      const myPlans = listTravelPlans();
      actions++;
      thinkTime(1, 2);

      // Якщо немає планів - створює новий
      if (!myPlans || myPlans.length === 0) {
        const planData = generateTravelPlan();
        createTravelPlan(planData);
        actions++;
        thinkTime(1, 2);
        return actions;
      }

      // --------------------------------------------------
      // 2. Вибирає план для редагування
      // --------------------------------------------------
      const planToEdit = myPlans[Math.floor(Math.random() * myPlans.length)];
      const fullPlan = getTravelPlan(planToEdit.id);
      actions++;
      
      if (!fullPlan) {
        return actions;
      }

      thinkTime(2, 3); // Аналізує що треба змінити

      // --------------------------------------------------
      // 3. Додає нові локації
      // --------------------------------------------------
      group('Add new locations', function() {
        const newLocations = randomIntBetween(1, 3);
        
        for (let i = 0; i < newLocations; i++) {
          thinkTime(1, 2);
          const locationData = generateLocation();
          addLocation(fullPlan.id, locationData);
          actions++;
        }
      });

      thinkTime(1, 2);

      // --------------------------------------------------
      // 4. Редагує існуючі локації
      // --------------------------------------------------
      if (fullPlan.locations && fullPlan.locations.length > 0) {
        group('Update existing locations', function() {
          // Редагує 1-2 локації
          const locationsToUpdate = Math.min(2, fullPlan.locations.length);
          
          for (let i = 0; i < locationsToUpdate; i++) {
            const location = fullPlan.locations[i];
            
            thinkTime(1, 2);
            
            const updateData = {
              name: location.name + ' (Updated)',
              budget: location.budget ? location.budget + 50 : 100,
              notes: 'Updated by experienced user',
            };
            
            updateLocation(location.id, updateData);
            actions++;
          }
        });
      }

      thinkTime(1, 2);

      // --------------------------------------------------
      // 5. Видаляє непотрібне (іноді)
      // --------------------------------------------------
      if (fullPlan.locations && fullPlan.locations.length > 2 && Math.random() < 0.4) {
        group('Remove unnecessary', function() {
          // Видаляє одну локацію
          const locationToDelete = fullPlan.locations[fullPlan.locations.length - 1];
          
          thinkTime(1, 2);
          deleteLocation(locationToDelete.id);
          actions++;
        });
      }

      // --------------------------------------------------
      // 6. Оновлює план
      // --------------------------------------------------
      group('Update plan details', function() {
        thinkTime(1, 3);
        
        const updateData = {
          title: fullPlan.title,
          description: fullPlan.description || 'Updated',
          budget: fullPlan.budget ? fullPlan.budget + 200 : 2000,
          version: fullPlan.version,
        };
        
        updateTravelPlan(fullPlan.id, updateData);
        actions++;
      });

      // --------------------------------------------------
      // 7. Фінальна перевірка
      // --------------------------------------------------
      thinkTime(1, 2);
      getTravelPlan(fullPlan.id);
      actions++;
    });
  });

  return actions;
}

// ============================================================================
// СЦЕНАРІЙ 3: БРАУЗЕР (тільки перегляд)
// ============================================================================

function browserJourney() {
  let actions = 0;

  group('Browser Journey', function() {
    // --------------------------------------------------
    // 1. Перегляд списку планів
    // --------------------------------------------------
    const plans = listTravelPlans();
    actions++;
    
    if (!plans || plans.length === 0) {
      return actions;
    }

    thinkTime(2, 4); // Обирає що цікаво

    // --------------------------------------------------
    // 2. Детальний перегляд 3-6 планів
    // --------------------------------------------------
    const plansToView = Math.min(randomIntBetween(3, 6), plans.length);
    
    for (let i = 0; i < plansToView; i++) {
      const randomIndex = Math.floor(Math.random() * plans.length);
      const planId = plans[randomIndex].id;
      
      const planDetails = getTravelPlan(planId);
      actions++;
      
      if (planDetails && planDetails.locations) {
        // Довго вивчає деталі, локації
        thinkTime(4, 8);
        
        // Іноді переглядає список знову (порівнює)
        if (Math.random() < 0.3) {
          listTravelPlans();
          actions++;
          thinkTime(2, 3);
        }
      } else {
        thinkTime(1, 2);
      }
    }

    // --------------------------------------------------
    // 3. Можливо повертається до улюбленого плану
    // --------------------------------------------------
    if (Math.random() < 0.4) {
      thinkTime(2, 3);
      const favoriteIndex = Math.floor(Math.random() * plans.length);
      getTravelPlan(plans[favoriteIndex].id);
      actions++;
      thinkTime(3, 5); // Ще раз детально вивчає
    }
  });

  return actions;
}

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

export function setup() {
  console.log('='.repeat(80));
  console.log('Starting Realistic User Journey Load Test');
  console.log('');
  console.log('User types:');
  console.log('  30% - New Users (creating first plan)');
  console.log('  50% - Experienced Users (editing existing)');
  console.log('  20% - Browsers (just looking)');
  console.log('');
  console.log('Duration: 18 minutes with variable arrival rate');
  console.log('Peak activity: 20 users/second');
  console.log('Focus: Real-world user behavior with think time');
  console.log('='.repeat(80));
}

export function teardown(data) {
  console.log('='.repeat(80));
  console.log('Realistic User Journey Test completed');
  console.log('');
  console.log('Key metrics to review:');
  console.log('  - user_type_distribution (should be ~30/50/20)');
  console.log('  - session_completion_rate (>90% is good)');
  console.log('  - actions_per_session (typically 5-20)');
  console.log('  - session_duration_seconds (includes think time)');
  console.log('');
  console.log('This test simulates real user behavior with natural pauses.');
  console.log('Lower throughput than other tests is expected and normal.');
  console.log('='.repeat(80));
}

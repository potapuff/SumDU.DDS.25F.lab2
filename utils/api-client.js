/**
 * API Client
 * Допоміжні функції для роботи з Travel Planner API
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { ENDPOINTS, DEFAULT_HEADERS } from '../config/endpoints.js';

// Кастомні метрики
export const errorRate = new Rate('api_errors');
export const conflictRate = new Rate('optimistic_lock_conflicts');

/**
 * Виконує HTTP запит з перевірками та метриками
 * @param {string} method - HTTP метод
 * @param {string} url - URL
 * @param {object} body - Тіло запиту (опціонально)
 * @param {object} expectedStatus - Очікуваний статус код
 * @param {string} operationType - Тип операції для метрик (read/write)
 * @returns {object} Відповідь від API
 */
function makeRequest(method, url, body = null, expectedStatuses = [200], operationType = 'read') {

  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];

  const params = {
    headers: DEFAULT_HEADERS,
    tags: {
      type: operationType,
      endpoint: url.replace(/\/[0-9a-f-]{36}/g, '/:id'),
    },
    responseCallback: http.expectedStatuses(...statuses),
  };

  let response;
  if (body) {
    response = http.request(method, url, JSON.stringify(body), params);
  } else {
    response = http.request(method, url, null, params);
  }

  const statusCheck = check(response, {
    [`status is one of [${statuses.join(',')}]`]: (r) => statuses.includes(r.status),
  });

  if (!statusCheck) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  // Трекінг конфліктів залишається як є. Він буде спрацьовувати, але не викликатиме помилку.
  if (response.status === 409) {
    conflictRate.add(1);
  }

  return response;
}

/**
 * Створює новий travel plan
 * @param {object} planData - Дані для створення плану
 * @returns {object} Створений план або null
 */
export function createTravelPlan(planData) {
  const response = makeRequest(
    'POST',
    ENDPOINTS.TRAVEL_PLANS,
    planData,
    201,
    'write'
  );

  const success = check(response, {
    'plan created successfully': (r) => r.status === 201,
    'plan has valid UUID': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.id);
      } catch (e) {
        console.error(`❌ Failed to parse response body for plan creation:`, e.message);
        console.error(`   Response body: ${r.body}`);
        return false;
      }
    },
    'plan has version 1': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return body.version === 1;
      } catch (e) {
        console.error(`❌ Failed to parse response body for version check:`, e.message);
        console.error(`   Response body: ${r.body}`);
        return false;
      }
    },
  });

  if (response.status !== 201) {
    console.error(`❌ POST /api/travel-plans failed with status ${response.status}`);
    console.error(`   Request data: ${JSON.stringify(planData)}`);
    console.error(`   Response body: ${response.body}`);
    return null;
  }

  if (!success) {
    console.error(`❌ Checks failed for plan creation`);
    console.error(`   Status: ${response.status}`);
    console.error(`   Response body: ${response.body}`);
    return null;
  }

  try {
    const plan = JSON.parse(response.body);
    console.debug(`✓ Successfully created plan: ${plan.id}, title="${plan.title}", version=${plan.version}`);
    return plan;
  } catch (e) {
    console.error(`❌ Failed to parse JSON for created plan:`, e.message);
    console.error(`   Response body: ${response.body}`);
    return null;
  }
}

/**
 * Отримує travel plan за ID
 * @param {string} planId - ID плану
 * @returns {object} План або null
 */
export function getTravelPlan(planId) {
  const response = makeRequest(
    'GET',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    null,
    200,
    'read'
  );

  // Зберігаємо результат check() для діагностики
  const checksPassed = check(response, {
    'plan retrieved successfully': (r) => r.status === 200,
    'plan has locations array': (r) => {
      if (r.status !== 200) return false;
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.locations);
      } catch (e) {
        console.error(`❌ Failed to parse response body for plan ${planId}:`, e.message);
        console.error(`   Response body: ${r.body}`);
        return false;
      }
    },
  });

  // Додаткове логування для діагностики
  if (response.status !== 200) {
    console.error(`❌ GET /api/travel-plans/${planId} failed with status ${response.status}`);
    console.error(`   Response body: ${response.body}`);
    return null;
  }

  if (!checksPassed) {
    console.error(`❌ Checks failed for plan ${planId}`);
    console.error(`   Status: ${response.status}`);
    console.error(`   Response body: ${response.body}`);
    return null;
  }

  try {
    const plan = JSON.parse(response.body);
    console.debug(`✓ Successfully retrieved plan ${planId}: title="${plan.title}", locations=${plan.locations?.length || 0}`);
    return plan;
  } catch (e) {
    console.error(`❌ Failed to parse JSON for plan ${planId}:`, e.message);
    console.error(`   Response body: ${response.body}`);
    return null;
  }
}

/**
 * Перевіряє чи план видалений (очікує 404)
 * @param {string} planId - ID плану
 * @returns {boolean} true якщо план дійсно видалений
 */
export function verifyPlanDeleted(planId) {
  const response = makeRequest(
    'GET',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    null,
    404, // Очікуємо 404 для видаленого плану
    'read'
  );

  const isDeleted = check(response, {
    'plan is deleted (404)': (r) => r.status === 404,
  });

  if (isDeleted) {
    console.debug(`✓ Verified plan ${planId} is deleted (404)`);
  } else {
    console.error(`❌ Plan ${planId} should be deleted but returned status ${response.status}`);
    console.error(`   Response body: ${response.body}`);
  }

  return isDeleted;
}

/**
 * Оновлює travel plan
 * @param {string} planId - ID плану
 * @param {object} updateData - Дані для оновлення (повинні містити version)
 * @returns {object} Оновлений план або null
 */
export function updateTravelPlan(planId, updateData) {
  const response = makeRequest(
    'PUT',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    updateData,
    [200, 409],
    'write'
  );

  check(response, {
    'plan updated successfully': (r) => r.status === 200,
    'version incremented': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return body.version === updateData.version + 1;
    },
  });

  if (response.status === 200) {
    return JSON.parse(response.body);
  }
  
  // Якщо 409 - це конфлікт версій (очікувана поведінка в race condition тестах)
  if (response.status === 409) {
    return { conflict: true, body: JSON.parse(response.body) };
  }
  
  return null;
}

/**
 * Видаляє travel plan
 * @param {string} planId - ID плану
 * @returns {boolean} true якщо успішно видалено
 */
export function deleteTravelPlan(planId) {
  const response = makeRequest(
    'DELETE',
    ENDPOINTS.TRAVEL_PLAN_BY_ID(planId),
    null,
    204,
    'write'
  );

  return check(response, {
    'plan deleted successfully': (r) => r.status === 204,
  });
}

/**
 * Додає локацію до travel plan
 * @param {string} planId - ID плану
 * @param {object} locationData - Дані локації
 * @returns {object} Створена локація або null
 */
export function addLocation(planId, locationData) {
  const response = makeRequest(
    'POST',
    ENDPOINTS.LOCATIONS_FOR_PLAN(planId),
    locationData,
    201,
    'write'
  );

  const success = check(response, {
    'location created successfully': (r) => r.status === 201,
    'location has visit_order': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return body.visit_order >= 1;
      } catch (e) {
        console.error(`❌ Failed to parse response body for location visit_order check:`, e.message);
        console.error(`   Response body: ${r.body}`);
        return false;
      }
    },
    'location linked to plan': (r) => {
      if (r.status !== 201) return false;
      try {
        const body = JSON.parse(r.body);
        return body.travel_plan_id === planId;
      } catch (e) {
        console.error(`❌ Failed to parse response body for location plan link check:`, e.message);
        console.error(`   Response body: ${r.body}`);
        return false;
      }
    },
  });

  if (response.status !== 201) {
    console.error(`❌ POST /api/travel-plans/${planId}/locations failed with status ${response.status}`);
    console.error(`   Request data: ${JSON.stringify(locationData)}`);
    console.error(`   Response body: ${response.body}`);
    return null;
  }

  if (!success) {
    console.error(`❌ Checks failed for location creation`);
    console.error(`   Status: ${response.status}`);
    console.error(`   Response body: ${response.body}`);
    return null;
  }

  try {
    const location = JSON.parse(response.body);
    console.debug(`✓ Successfully added location: ${location.id}, name="${location.name}", visit_order=${location.visit_order}`);
    return location;
  } catch (e) {
    console.error(`❌ Failed to parse JSON for created location:`, e.message);
    console.error(`   Response body: ${response.body}`);
    return null;
  }
}

/**
 * Оновлює локацію
 * @param {string} locationId - ID локації
 * @param {object} updateData - Дані для оновлення
 * @returns {object} Оновлена локація або null
 */
export function updateLocation(locationId, updateData) {
  const response = makeRequest(
    'PUT',
    ENDPOINTS.LOCATION_BY_ID(locationId),
    updateData,
    [200, 409],
    'write'
  );

  check(response, {
    'location updated successfully': (r) => r.status === 200,
  });

  if (response.status === 200) {
    return JSON.parse(response.body);
  }
  return null;
}

/**
 * Видаляє локацію
 * @param {string} locationId - ID локації
 * @returns {boolean} true якщо успішно видалено
 */
export function deleteLocation(locationId) {
  const response = makeRequest(
    'DELETE',
    ENDPOINTS.LOCATION_BY_ID(locationId),
    null,
    204,
    'write'
  );

  return check(response, {
    'location deleted successfully': (r) => r.status === 204,
  });
}

/**
 * Отримує список всіх travel plans
 * @returns {array} Масив планів або null
 */
export function listTravelPlans() {
  const response = makeRequest(
    'GET',
    ENDPOINTS.TRAVEL_PLANS,
    null,
    200,
    'read'
  );

  check(response, {
    'plans list retrieved': (r) => r.status === 200,
    'response is array': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return Array.isArray(body);
    },
  });

  if (response.status === 200) {
    return JSON.parse(response.body);
  }
  return null;
}

/**
 * Перевіряє здоров'я API
 * @returns {boolean} true якщо API здоровий
 */
export function checkHealth() {
  const response = makeRequest(
    'GET',
    ENDPOINTS.HEALTH,
    null,
    200,
    'read'
  );

  return check(response, {
    'API is healthy': (r) => r.status === 200,
    'status is healthy': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return body.status === 'healthy';
    },
  });
}

/**
 * Виконує валідаційний тест (очікується помилка 400)
 * @param {string} method - HTTP метод
 * @param {string} url - URL
 * @param {object} invalidData - Невалідні дані
 * @returns {boolean} true якщо валідація спрацювала коректно
 */
export function testValidation(method, url, invalidData) {
  const response = makeRequest(
    method,
    url,
    invalidData,
    400,
    'write'
  );

  return check(response, {
    'validation error returned': (r) => r.status === 400,
    'error message present': (r) => {
      if (r.status !== 400) return false;
      const body = JSON.parse(r.body);
      return body.error && body.error.includes('Validation');
    },
  });
}

/**
 * Додає паузу між діями (think time)
 * @param {number} min - Мінімальна пауза в секундах
 * @param {number} max - Максимальна пауза в секундах
 */
export function thinkTime(min = 1, max = 3) {
  const duration = Math.random() * (max - min) + min;
  sleep(duration);
}

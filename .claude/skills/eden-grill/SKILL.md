```markdown
# eden-grill Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `eden-grill` JavaScript repository. You'll learn about file organization, code style, import/export patterns, and how to write and organize tests. While no specific frameworks or automated workflows are detected, this guide provides clear instructions and code examples to help you contribute effectively.

## Coding Conventions

### File Naming
- **Style:** kebab-case
- **Example:**  
  ```
  user-profile.js
  order-handler.js
  ```

### Imports
- **Style:** Relative imports
- **Example:**
  ```javascript
  import { getUser } from './user-utils.js';
  import { calculateTotal } from '../utils/math.js';
  ```

### Exports
- **Style:** Named exports
- **Example:**
  ```javascript
  // In product-list.js
  export function getProductList() { ... }
  export const PRODUCT_LIMIT = 100;
  ```

### Commit Messages
- **Type:** Freeform (no strict prefixes)
- **Average Length:** ~29 characters
- **Examples:**
  ```
  fix bug in order calculation
  add user authentication logic
  update menu item prices
  ```

## Workflows

_No automated workflows detected in this repository. All tasks are performed manually._

## Testing Patterns

- **Test File Pattern:** `*.test.*`  
  Place your test files alongside the code they test, using the `.test.` infix.
  - **Example:**
    ```
    order-handler.test.js
    user-profile.test.js
    ```
- **Testing Framework:** Unknown (no framework detected)
- **Writing Tests:**  
  Use plain JavaScript or your preferred testing library. Example with plain assertions:
  ```javascript
  // order-handler.test.js
  import { calculateOrder } from './order-handler.js';

  function testCalculateOrder() {
    const result = calculateOrder([10, 20]);
    if (result !== 30) {
      throw new Error('Order calculation failed');
    }
  }

  testCalculateOrder();
  ```

## Commands
| Command | Purpose |
|---------|---------|
| /add-test | Scaffold a new test file for a module |
| /lint-check | Review code for style consistency |
| /list-conventions | Display coding conventions summary |
```

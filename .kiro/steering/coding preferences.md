# Coding Preferences

## Core Rules

**Performance first**: Only implement features that measurably improve performance
**Direct data flow**: Pass data forward through pipeline stages, avoid circular dependencies
**Refactor over add**: Extend existing functions and move logic upstream instead of creating new components
**Trust data, log problems**: No silent failures or masking fallbacks - surface issues with clear logs
**Fix root causes**: Address underlying issues, not symptoms

## File Size Limits

**600-800 lines max per file**: If larger, split by functional responsibility or propose refactoring options

## Implementation Patterns

**Use native approaches**: Plain HTML insertion over DOM creation + querySelector for performance
**Fallback chains**: Use `mostReliable || lessReliable || guaranteed` pattern, not weighted options
**Avoid dynamic imports**: Use static imports when possible for better performance and bundling
**Service worker restriction**: Background service worker (anything in `background/` folder) CAN'T use dynamic imports - it's a Chrome extension restriction
**Leverage platform lifecycles**: Popup dies on close, service worker terminates, content scripts are per-tab
**Return rich data**: Better to return more from one call than make multiple calls
**Cache expensive operations only**: Don't cache cheap operations
**Fail fast**: Use warn/error logs with enough context to trace source

## Code Quality

**Use `npm run lint` for all syntax and style checks**: Run from project root for comprehensive linting across extension and native_host code - covers syntax, style, and Chrome extension best practices

## Code Organization

**Single responsibility per file**: One clear purpose per module
**Pipeline thinking**: Structure as sequential stages where each adds value
**Explicit dependencies**: Make imports and data flow obvious
**Message passing**: Use Chrome APIs for communication, not shared state
**Exports at end**: Use `export {}` statement at file end
**Complex functions need orchestration**: Break down into coordinated steps

## Extension Strategy

**Reuse and extend existing functionality**: Before creating new functions, extend current ones
**Switch to refactoring mode when multiple roles emerge**: Ask:

- Do we already have needed data from prior steps?
- Which functions can be reused or extracted as helpers?
- Which logic should be inline (never reused)?
- Should this function/file move to better streamline flow and separate concerns?

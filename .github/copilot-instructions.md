## PROJECT OVERVIEW

It's a **Chrome MV3 extension** designed to download **HLS**, **DASH**, and **direct video/audio**. It communicates with a **Node.js-powered native host** bundled with `ffmpeg` and `ffprobe` for efficient media processing.

The UI follows **modern UX/UI standards**: minimal, responsive, fast, and clean—with proper animation and structural clarity.

## CODING STANDARDS

- reuse existing code, instead of creating new code
- strive for streamlining data flow and function calls patterns
- general flow robustness and simplicity is my priority
- always keep in mind best practices in the industry
- when substituting functions, avoid creating thin wrappers
- think out of the box when looking for solutions
- analyze current data flow and function call stack before jumping to conclusions
- strive for simple solutions, avoid complexity
- always add precise data instead of mock values, use null for missing info instead of empty strings or 0, when appropriate
- use ES6+ syntax, HTML5, CSS3, and JS best practices
- critically evaluate all input and corrections from me, I might be mistaken, confused or even wrong and mislead you, stay focused on best practices and the project goals
- when you need to substitute a function, first perform a search in the codebase via terminal command to quickly find all instances and decide on the best approach to quickly and reliably update all of them
- when you reference any files (existing or new), use VSCode hyperlink format
- when there are multiple ways to achieve the same goal, always give me relevant options to choose from and explain the pros and cons of each option
- in code snippets in the first line always show which file it should be in

<!--
## RESPONSES

- when you outline a plan, structure your response this way:

  - Title: number and short clear title in heading styling
  - FILE: path to the file which needs to be updated/created
  - ACTIONS: short exact description of what needs to be done
  - REASON: clear explanation of what it addresses and why I need to implement this change
  - Code snippets: only show before snippet if it requires rewriting existing logic, and show only after when you just add code instead of rewriting, + clearly indicate what's new in the code

- when applicable, outline implementation order in simple steps (bold titles, regular body) with bullet lists for each step about what needs to be done in order -->

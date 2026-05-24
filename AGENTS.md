<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:app-rules -->
# Coding Rules

## Source Control

Use Github for source control.

## Feature branches

Develop features in branches and create PRs to merge changes into master.

## Tests

Use TDD. Write tests first, check for coverage, and then write code to make tests go green. Try for 100% coverage, but if that's not possible, get as close as possible. Automate tests with Github actions.


### Database

Use a test database so you're testing actual queries against actual data.


### Frontend

Use Playwright to test the frontend.


### Backend

Use Jest to test the backend.


# Changelog

Maintain a CHANGELOG.

# Readme

Maintain a README. It should include details on how to install the app, how to configure it, how to run it, and how to write scripts.

# CLAUDE.md

Update CLAUDE.md with new details that are discovered during development.


# Linting

Keep your code tidy by following linting rules. Make sure code style is enforced by using prettier and pre-commit hooks.


# Releases

Use semver for versioning. Keep the package.json version updated, and tag releases like `v#.#.#`. Automate the release process with Github actions.

<!-- END:app-rules -->

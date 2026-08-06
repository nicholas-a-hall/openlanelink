# Contributing to Lunar Lanes

Thank you for your interest in contributing to Lunar Lanes! This document provides guidelines and instructions for contributing to the project.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style Guide](#code-style-guide)
- [Testing Guidelines](#testing-guidelines)
- [Pull Request Process](#pull-request-process)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

---

## Code of Conduct

This project adheres to a Code of Conduct that all contributors are expected to follow. Please be respectful, inclusive, and constructive in all interactions.

**In short:**
- Be welcoming and respectful
- Be patient with newcomers
- Focus on what's best for the community
- Show empathy towards others

---

## Getting Started

### Prerequisites

- **Node.js** 20.0.0 or higher
- **npm** 9.0.0 or higher
- **Docker** (for local Redis)
- **Git**

### First-Time Contributors

Looking for a good first issue? Check out issues labeled:
- `good first issue` - Beginner-friendly tasks
- `help wanted` - Issues where we need community help
- `documentation` - Documentation improvements

---

## Development Setup

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/lunar-lanes.git
cd lunar-lanes
```

### 2. Install Dependencies

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

# Install kiosk dependencies
cd ../kiosk
npm install
```

### 3. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env and add your configuration
# See GOOGLE_CALENDAR.md for setting up Google Calendar integration
```

### 4. Start Development Servers

**Option A: Using Docker Compose (Recommended)**
```bash
# From project root
docker-compose up
```

**Option B: Manual Setup**
```bash
# Terminal 1: Start Redis
docker run -p 6379:6379 redis:7-alpine

# Terminal 2: Start Backend
cd backend
npm run dev

# Terminal 3: Start Frontend
cd frontend
npm run dev

# Terminal 4: Start Kiosk (optional)
cd kiosk
npm run dev
```

### 5. Verify Setup

- Manager Dashboard: http://localhost:8080
- Backend API: http://localhost:3001
- Kiosk Display: http://localhost:8081

---

## Project Structure

```
lunar-lanes/
├── backend/          # Node.js + Express + Socket.IO server
│   ├── server.js     # Main server file
│   └── googleCalendar.js
├── frontend/         # React manager dashboard
│   └── src/
│       ├── App.jsx
│       ├── shared.js
│       └── components/
├── kiosk/            # React kiosk displays
│   └── src/
│       └── LunarLanesKiosk.jsx
├── helm/             # Kubernetes deployment charts
└── docs/             # Documentation
```

---

## Code Style Guide

### General Principles

1. **Inline Styles Only** - This project uses inline React styles exclusively (no CSS files)
2. **Shared Constants** - Always use color/font constants from `shared.js`
3. **Responsive Design** - Use `useCompact()` hook for mobile responsiveness
4. **Uppercase UI Text** - All buttons, labels, and status text should be uppercase

### Style Example

```javascript
// ✅ CORRECT
import { C, F, useCompact } from '../shared';

function MyComponent() {
  const compact = useCompact();

  return (
    <button style={{
      fontFamily: F.mono,
      fontSize: compact ? '0.65rem' : '0.72rem',
      color: C.blue,
      background: `${C.blue}08`,
      border: `1.5px solid ${C.blue}55`,
      borderRadius: 5,
      padding: compact ? '8px 10px' : '10px 14px',
      textTransform: 'uppercase'
    }}>
      Click Me
    </button>
  );
}

// ❌ WRONG - External CSS
import './styles.css';
<div className="my-component">

// ❌ WRONG - Arbitrary colors
<div style={{ color: '#ff0000' }}>

// ❌ WRONG - Missing responsive design
<div style={{ fontSize: '1rem' }}>  // Should check compact
```

### Naming Conventions

- **Components:** PascalCase (`ReservationForm`, `LaneCard`)
- **Functions:** camelCase (`createReservation`, `handleClick`)
- **Constants:** UPPER_SNAKE_CASE (`MAX_LANES`, `DEFAULT_DURATION`)
- **Files:** Match component name (`ReservationForm.jsx`)

### Code Organization

- Keep files under 300 lines when possible
- Extract reusable components
- Group related functionality
- Add comments for complex logic

---

## Testing Guidelines

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

### Writing Tests

**Test file naming:**
- Backend: `*.test.js` in `__tests__/` directory
- Frontend: `*.test.jsx` alongside component

**Example test structure:**
```javascript
describe('ReservationForm', () => {
  it('should validate required fields', () => {
    // Arrange
    const { getByText, getByLabelText } = render(<ReservationForm />);

    // Act
    fireEvent.click(getByText('Create Reservation'));

    // Assert
    expect(getByText('Please select a date')).toBeInTheDocument();
  });
});
```

### Test Coverage Requirements

- All new features must include tests
- Minimum 70% coverage for new code
- Critical paths must have 100% coverage

---

## Pull Request Process

### Before Submitting

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow code style guidelines
   - Add tests for new features
   - Update documentation

3. **Test your changes**
   ```bash
   npm test
   npm run lint
   ```

4. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add new reservation validation"
   ```

5. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

### Submitting the PR

1. Go to GitHub and create a Pull Request
2. Fill out the PR template completely
3. Link related issues (e.g., "Closes #123")
4. Request review from maintainers

### PR Requirements

- [ ] All tests pass
- [ ] Code follows style guidelines
- [ ] Documentation is updated
- [ ] Commit messages follow conventions
- [ ] No merge conflicts
- [ ] Description explains what and why

### Review Process

1. Automated checks must pass (CI/CD)
2. At least one maintainer approval required
3. Address review comments
4. Maintainer will merge when ready

---

## Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, no logic change)
- `refactor:` Code refactoring
- `test:` Adding or updating tests
- `chore:` Maintenance tasks

### Examples

```bash
# Good commits
git commit -m "feat(reservation): add multi-lane booking support"
git commit -m "fix(timeline): prevent re-animation on state update"
git commit -m "docs(readme): add quick start section"

# Bad commits
git commit -m "fixed stuff"
git commit -m "WIP"
git commit -m "updates"
```

### Scope

Common scopes:
- `backend` - Backend server changes
- `frontend` - Manager dashboard changes
- `kiosk` - Kiosk display changes
- `docs` - Documentation
- `helm` - Kubernetes deployment
- `ci` - CI/CD pipeline

---

## Reporting Bugs

### Before Submitting

1. Check existing issues for duplicates
2. Verify you're using the latest version
3. Test in a clean environment

### Bug Report Template

```markdown
**Describe the bug**
Clear description of the issue

**To Reproduce**
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What should happen

**Screenshots**
If applicable

**Environment:**
- OS: [e.g., macOS 14.0]
- Browser: [e.g., Chrome 120]
- Node version: [e.g., 20.0.0]
- Docker version: [if applicable]

**Additional context**
Any other relevant information
```

---

## Suggesting Features

### Feature Request Guidelines

1. **Check existing issues** - Your idea might already be proposed
2. **Describe the problem** - What user need does this address?
3. **Propose a solution** - How should it work?
4. **Consider alternatives** - What other approaches exist?
5. **Provide context** - Who benefits? How often would it be used?

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
Clear description of the problem

**Describe the solution you'd like**
Detailed description of the proposed feature

**Describe alternatives you've considered**
Other approaches you've thought about

**Additional context**
Mockups, examples, or use cases
```

---

## Development Workflow

### Branching Strategy

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `fix/*` - Bug fixes
- `docs/*` - Documentation updates

### Local Development Tips

1. **Use hot reload** - Both frontend and backend support hot reload
2. **Check WebSocket connection** - Watch browser console for socket errors
3. **Monitor backend logs** - Server logs show all Socket.IO actions
4. **Test on mobile** - Use browser dev tools responsive mode
5. **Clear Redis data** - `redis-cli FLUSHALL` to reset state

### Debugging

**Backend:**
```bash
# Enable debug logging
DEBUG=* npm run dev

# Or specific namespace
DEBUG=socket.io:* npm run dev
```

**Frontend:**
```javascript
// Check WebSocket status in browser console
console.log('Socket connected:', window.socket?.connected);
```

**Redis:**
```bash
# Check stored data
redis-cli
> KEYS *
> GET lunar-lanes:state
```

---

## Documentation

### When to Update Docs

- New features or API changes → Update `README.md`, `API.md`
- Code examples changed → Update `DEVELOPER_GUIDE.md`
- UI/UX changes → Update `STYLEGUIDE.md`
- User-facing changes → Update `USER_MANUAL.md`
- Deployment changes → Update `helm/` documentation

### Documentation Style

- Use clear, concise language
- Include code examples
- Add screenshots for UI changes
- Keep formatting consistent
- Test all commands/examples

---

## Questions?

- **General questions:** Open a GitHub Discussion
- **Bug reports:** Open a GitHub Issue
- **Security issues:** See SECURITY.md (do not open public issue)
- **Feature requests:** Open a GitHub Issue with "Feature Request" label

---

## License

By contributing to Lunar Lanes, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Lunar Lanes! 🎳🌙

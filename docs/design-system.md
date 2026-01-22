# Design System Documentation

This document describes the design system used in the Calorie Counter app. The design system is implemented via Tailwind CSS configuration and ensures consistency across all pages.

## Table of Contents

1. [Colors](#colors)
2. [Typography](#typography)
3. [Spacing](#spacing)
4. [Components](#components)
5. [Layout Patterns](#layout-patterns)
6. [Usage Guidelines](#usage-guidelines)

---

## Colors

### Primary Color (Indigo)

Used for interactive elements, CTAs, and focus states.

```css
bg-indigo-600   /* Main: #4f46e5 - Buttons, primary actions */
bg-indigo-700   /* Hover: #4338ca - Button hover states */
text-indigo-600 /* Text color for links and highlights */
```

**Usage:**

- Primary buttons: `bg-indigo-600 hover:bg-indigo-700`
- Links and accents: `text-indigo-600`
- Focus rings: `focus:ring-indigo-500 focus:border-indigo-500`

### Gray Scale

Used for text, backgrounds, and borders.

```css
text-gray-900   /* Primary text: #111827 */
text-gray-600   /* Secondary text: #4b5563 */
text-gray-500   /* Tertiary text: #6b7280 */
bg-gray-50      /* Light background: #f9fafb */
bg-gray-100     /* Subtle background: #f3f4f6 */
border-gray-300 /* Standard borders: #d1d5db */
```

**Usage:**

- Page titles: `text-gray-900`
- Body text: `text-gray-600`
- Placeholder text: `text-gray-500`
- Card backgrounds: `bg-white` or `bg-gray-50`

### Status Colors

```css
/* Success - Green */
bg-green-50 border-green-200 text-green-800  /* Success messages */

/* Error - Red */
bg-red-50 border-red-200 text-red-800        /* Error messages */
bg-red-600 hover:bg-red-700 text-white       /* Danger buttons */

/* Info - Blue */
bg-blue-50 border-blue-200 text-blue-800     /* Info messages */
```

---

## Typography

### Font Sizes and Line Heights

All text sizes include optimized line heights for readability.

```css
text-xs    /* 12px / 16px - Captions, small labels */
text-sm    /* 14px / 20px - Secondary text, form labels */
text-base  /* 16px / 24px - Body text (default) */
text-lg    /* 18px / 28px - H3, subsection headings */
text-xl    /* 20px / 28px - H2, card titles */
text-2xl   /* 24px / 32px - H1, page titles */
text-3xl   /* 30px / 36px - Hero text */
```

### Font Weights

```css
font-normal   /* 400 - Body text */
font-medium   /* 500 - Buttons, emphasis */
font-semibold /* 600 - Subsection headings */
font-bold     /* 700 - Page titles, headings */
```

### Typography Hierarchy

```html
<!-- Page Title -->
<h1 class="text-2xl font-bold text-gray-900">Page Title</h1>

<!-- Section Heading -->
<h2 class="text-lg font-semibold text-gray-900">Section Title</h2>

<!-- Body Text -->
<p class="text-base text-gray-600">Body content here</p>

<!-- Secondary Text -->
<span class="text-sm text-gray-500">Secondary information</span>

<!-- Small Text / Captions -->
<small class="text-xs text-gray-500">Caption text</small>
```

---

## Spacing

Based on a 4px baseline grid (0.25rem = 4px).

### Common Spacing Values

```css
space-y-1  /* 4px - Tight spacing */
space-y-2  /* 8px - Small spacing */
space-y-4  /* 16px - Standard spacing */
space-y-6  /* 24px - Large spacing (recommended for sections) */
space-y-8  /* 32px - Extra large spacing */
```

### Padding Standards

```css
/* Containers */
py-6       /* 24px vertical - Standard page padding */

/* Cards */
p-6        /* 24px all sides - Standard card padding */
p-4        /* 16px all sides - Dense content */

/* Buttons */
py-2 px-4  /* 8px vertical, 16px horizontal */
```

### Margin Standards

```css
mb-2  /* 8px - Small bottom margin */
mb-4  /* 16px - Standard bottom margin */
mb-6  /* 24px - Large bottom margin */
```

---

## Components

### Buttons

#### Primary Button

```html
<button
  class="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded-lg font-medium"
>
  Primary Action
</button>
```

#### Danger Button

```html
<button
  class="bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded-lg font-medium"
>
  Delete
</button>
```

#### Secondary Button

```html
<button
  class="bg-gray-200 hover:bg-gray-300 text-gray-700 py-2 px-4 rounded-lg font-medium"
>
  Cancel
</button>
```

#### Disabled State

Add `disabled:opacity-50 disabled:cursor-not-allowed` to any button.

### Cards

#### Standard Card

```html
<div class="bg-white rounded-lg shadow-sm p-6">
  <!-- Card content -->
</div>
```

#### Dense Card (less padding)

```html
<div class="bg-white rounded-lg shadow-sm p-4">
  <!-- Card content -->
</div>
```

### Status Boxes

#### Info Box

```html
<div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
  <div class="text-sm font-medium text-blue-800">Title</div>
  <div class="text-sm text-blue-700">Message content</div>
</div>
```

#### Error Box

```html
<div class="bg-red-50 border border-red-200 rounded-lg p-4">
  <div class="text-sm font-medium text-red-800">Error</div>
  <div class="text-sm text-red-700">Error message</div>
</div>
```

#### Success Box

```html
<div class="bg-green-50 border border-green-200 rounded-lg p-4">
  <div class="text-sm font-medium text-green-800">Success</div>
  <div class="text-sm text-green-700">Success message</div>
</div>
```

### Form Elements

#### Input Field

```html
<input
  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm 
         focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
  type="text"
/>
```

#### Label

```html
<label class="block text-sm font-medium text-gray-700 mb-2">
  Field Label
</label>
```

#### Helper Text

```html
<p class="text-xs text-gray-500 mt-1">Helper text goes here</p>
```

---

## Layout Patterns

### Page Layout

All app pages follow this structure:

```html
<div class="py-6">
  <!-- Page header -->
  <div class="mb-6">
    <h1 class="text-2xl font-bold text-gray-900">Page Title</h1>
    <p class="text-gray-600">Page description</p>
  </div>

  <!-- Page content with section spacing -->
  <div class="space-y-6">
    <!-- Content sections -->
  </div>
</div>
```

### Centered Narrow Layout

For configuration and form pages:

```html
<div class="py-6">
  <div class="max-w-md mx-auto">
    <!-- Content -->
  </div>
</div>
```

### Full-Width Layout

For journal, analytics, and other data-heavy pages:

```html
<div class="py-6">
  <!-- Full-width content -->
</div>
```

---

## Usage Guidelines

### Do's ✓

1. **Use consistent spacing**

   - Stick to `py-6` for page padding
   - Use `space-y-6` for section spacing
   - Use `mb-6` for major section breaks

2. **Follow the typography hierarchy**

   - H1: `text-2xl font-bold text-gray-900`
   - H2: `text-lg font-semibold text-gray-900`
   - Body: `text-base text-gray-600`

3. **Use semantic colors**

   - Indigo for primary actions
   - Red for destructive actions
   - Green for success states
   - Blue for informational content

4. **Maintain visual hierarchy**
   - Cards use `bg-white rounded-lg shadow-sm`
   - Status boxes use colored backgrounds with borders
   - Buttons have clear visual weight

### Don'ts ✗

1. **Don't mix spacing scales**

   - Don't use `py-4` and `py-8` on the same page
   - Stick to `py-6` for consistency

2. **Don't create custom colors**

   - Use the defined color palette
   - Avoid arbitrary color values

3. **Don't skip the hierarchy**

   - Don't jump from H1 to H3
   - Maintain logical heading structure

4. **Don't over-design**
   - Keep it simple and functional
   - Avoid unnecessary visual complexity

---

## Quick Reference

### Common Class Combinations

```css
/* Page Container */
py-6

/* Section Container */
space-y-6

/* Card */
bg-white rounded-lg shadow-sm p-6

/* Button Primary */
bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded-lg font-medium

/* Button Danger */
bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded-lg font-medium

/* Page Title */
text-2xl font-bold text-gray-900

/* Body Text */
text-base text-gray-600

/* Info Box */
bg-blue-50 border border-blue-200 rounded-lg p-4
```

---

## Accessibility Notes

1. **Color Contrast**: All text colors meet WCAG AA standards
2. **Focus States**: Interactive elements have visible focus rings
3. **Touch Targets**: Buttons have minimum 44px height for mobile
4. **Semantic HTML**: Use proper heading hierarchy and semantic elements

---

## Future Considerations

As the app grows, consider:

- Adding dark mode support
- Creating component variants (small, large buttons)
- Adding animation utilities
- Expanding the color palette if needed

Remember: Consistency is key to a good user experience.

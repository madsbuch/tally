/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /**
       * DESIGN SYSTEM
       *
       * This app uses a custom color palette inspired by nature:
       *
       * COLOR USAGE:
       * - Primary (Forest): forest - Interactive elements, CTAs, headings
       * - Secondary (Sage): sage - Accents, hover states
       * - Background (Cream/Soft White): cream, soft-white - Backgrounds, surfaces
       * - Text (Charcoal): charcoal - Primary text color
       * - Neutrals (Gray): gray-50 to gray-900 - Borders, secondary text
       * - Danger (Red): red-600, red-700 - Destructive actions, errors
       * - Success (Green): green-50, green-200, green-800 - Success messages
       * - Info (Blue): blue-50, blue-200, blue-800 - Informational content
       */

      colors: {
        forest: '#2d5f3f',
        sage: '#a8c5a8',
        cream: '#fdfdf8',
        charcoal: '#2a2a2a',
        'soft-white': '#f8f9f5',
      },

      fontFamily: {
        serif: ['Crimson Pro', 'serif'],
        sans: ['DM Sans', 'sans-serif'],
      },
      
      /**
       * TYPOGRAPHY SYSTEM
       * 
       * Font sizes follow a type scale for consistent hierarchy.
       * Line heights are optimized for readability.
       */
      fontSize: {
        // Body text
        'xs': ['0.75rem', { lineHeight: '1rem' }],      // 12px - Small text, captions
        'sm': ['0.875rem', { lineHeight: '1.25rem' }],  // 14px - Secondary text
        'base': ['1rem', { lineHeight: '1.5rem' }],     // 16px - Body text
        
        // Headings
        'lg': ['1.125rem', { lineHeight: '1.75rem' }],  // 18px - H3, subsections
        'xl': ['1.25rem', { lineHeight: '1.75rem' }],   // 20px - H2, card titles
        '2xl': ['1.5rem', { lineHeight: '2rem' }],      // 24px - H1, page titles
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }], // 30px - Hero text
      },
      
      /**
       * SPACING SYSTEM
       * 
       * Consistent spacing helps create visual rhythm.
       * Based on 4px baseline grid (0.25rem = 4px).
       */
      spacing: {
        // Common spacing values used in the design system
        '0.5': '0.125rem',  // 2px - Minimal spacing
        '1': '0.25rem',     // 4px - Tight spacing
        '2': '0.5rem',      // 8px - Small spacing
        '3': '0.75rem',     // 12px - Medium-small spacing
        '4': '1rem',        // 16px - Standard spacing
        '5': '1.25rem',     // 20px - Medium spacing
        '6': '1.5rem',      // 24px - Large spacing
        '8': '2rem',        // 32px - Extra large spacing
        '12': '3rem',       // 48px - Section spacing
        '16': '4rem',       // 64px - Major section spacing
      },
      
      /**
       * BORDER RADIUS SYSTEM
       * 
       * Rounded corners create a friendly, modern look.
       */
      borderRadius: {
        'none': '0',
        'sm': '0.125rem',   // 2px - Subtle rounding
        DEFAULT: '0.25rem', // 4px - Standard rounding
        'md': '0.375rem',   // 6px - Medium rounding
        'lg': '0.5rem',     // 8px - Large rounding (cards, buttons)
        'xl': '0.75rem',    // 12px - Extra large rounding
        '2xl': '1rem',      // 16px - Major rounding
        'full': '9999px',   // Full circle
      },
      
      /**
       * SHADOW SYSTEM
       * 
       * Subtle shadows create depth and hierarchy.
       */
      boxShadow: {
        'xs': '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        'sm': '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
        DEFAULT: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        'md': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        'lg': '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
      },
      
      /**
       * TRANSITION SYSTEM
       * 
       * Smooth transitions improve UX.
       */
      transitionDuration: {
        DEFAULT: '150ms',
        'fast': '100ms',
        'normal': '200ms',
        'slow': '300ms',
      },
      
      /**
       * CONTAINER SYSTEM
       * 
       * Max widths for different content types.
       */
      maxWidth: {
        'xs': '20rem',      // 320px - Very narrow content
        'sm': '24rem',      // 384px - Narrow content
        'md': '28rem',      // 448px - Config/forms (used in app)
        'lg': '32rem',      // 512px - Standard content
        'xl': '36rem',      // 576px - Wide content
        '2xl': '42rem',     // 672px - Extra wide content
        '3xl': '48rem',     // 768px - Very wide content
        '4xl': '56rem',     // 896px - Ultra wide content
        '5xl': '64rem',     // 1024px - Maximum content width
        '6xl': '72rem',     // 1152px - Hero sections
        '7xl': '80rem',     // 1280px - Full width
      },
    },
  },
  plugins: [],
}

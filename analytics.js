/**
 * Vercel Web Analytics initialization
 * Loads and initializes Vercel Analytics for tracking page views and web vitals
 */
(function () {
  'use strict';

  // Initialize Vercel Analytics using the inject pattern
  // This will automatically track page views and web vitals
  try {
    // For static sites, Vercel injects analytics at deploy time
    // This script provides a fallback and explicit initialization
    window.va = window.va || function () { 
      (window.vaq = window.vaq || []).push(arguments); 
    };
  } catch (e) {
    console.warn('Vercel Analytics initialization failed:', e);
  }
})();

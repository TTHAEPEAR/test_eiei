// Theme Switcher
(function() {
  const themeBtn = document.getElementById('themeBtn');
  const themeModal = document.getElementById('themeModal');
  const closeModal = document.getElementById('closeModal');
  const themeOptions = document.querySelectorAll('.theme-option');
  
  // Load saved theme from localStorage
  const savedTheme = localStorage.getItem('chatTheme') || 'midnight';
  document.documentElement.setAttribute('data-theme', savedTheme);
  
  // Open modal
  themeBtn.addEventListener('click', () => {
    themeModal.classList.add('active');
  });
  
  // Close modal
  closeModal.addEventListener('click', () => {
    themeModal.classList.remove('active');
  });
  
  // Close modal when clicking outside
  themeModal.addEventListener('click', (e) => {
    if (e.target === themeModal) {
      themeModal.classList.remove('active');
    }
  });
  
  // Close modal with Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && themeModal.classList.contains('active')) {
      themeModal.classList.remove('active');
    }
  });
  
  // Theme selection
  themeOptions.forEach(option => {
    option.addEventListener('click', () => {
      const theme = option.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('chatTheme', theme);
      
      // Add feedback animation
      option.style.transform = 'scale(0.95)';
      setTimeout(() => {
        option.style.transform = '';
      }, 100);
      
      // Close modal after selection
      setTimeout(() => {
        themeModal.classList.remove('active');
      }, 300);
    });
  });
})();
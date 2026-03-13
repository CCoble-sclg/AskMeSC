<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { ChartData } from '$lib/types';

  export let data: ChartData;
  
  let wrapper: HTMLDivElement;
  let chart: any = null;

  const colors = [
    'rgba(79, 70, 229, 0.8)',
    'rgba(16, 185, 129, 0.8)',
    'rgba(245, 158, 11, 0.8)',
    'rgba(239, 68, 68, 0.8)',
    'rgba(59, 130, 246, 0.8)',
    'rgba(168, 85, 247, 0.8)',
    'rgba(236, 72, 153, 0.8)',
    'rgba(20, 184, 166, 0.8)',
  ];

  const borderColors = colors.map(c => c.replace('0.8', '1'));

  onMount(async () => {
    if (!browser || !data || !wrapper) return;
    
    try {
      const canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.maxHeight = '300px';
      wrapper.appendChild(canvas);
      
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);

      const isPie = data.type === 'pie' || data.type === 'doughnut';

      const datasets = data.datasets.map((dataset, i) => ({
        ...dataset,
        backgroundColor: dataset.backgroundColor || (isPie ? colors : colors[i % colors.length]),
        borderColor: dataset.borderColor || (isPie ? borderColors : borderColors[i % borderColors.length]),
        borderWidth: 2,
        tension: data.type === 'line' ? 0.3 : undefined,
      }));

      chart = new Chart(canvas, {
        type: data.type,
        data: {
          labels: data.labels,
          datasets,
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: !!data.title,
              text: data.title || '',
              font: { size: 14, weight: 'bold' },
              color: '#1f2937',
            },
            legend: {
              display: datasets.length > 1 || isPie,
              position: 'bottom',
            },
          },
          scales: isPie ? {} : {
            y: { beginAtZero: true },
            x: { display: true },
          },
        },
      });
    } catch (e) {
      console.error('Chart error:', e);
      if (wrapper) {
        wrapper.innerHTML = '<p style="color:red">Chart failed to load</p>';
      }
    }
  });

  onDestroy(() => {
    if (chart) chart.destroy();
  });
</script>

<div class="chart-wrapper" bind:this={wrapper}></div>

<style>
  .chart-wrapper {
    width: 100%;
    max-width: 600px;
    height: 300px;
    margin: 1rem 0;
    padding: 1rem;
    background: white;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }
</style>

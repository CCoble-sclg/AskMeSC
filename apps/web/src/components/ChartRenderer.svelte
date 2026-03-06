<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { ChartData } from '$lib/types';

  let { data }: { data: ChartData } = $props();
  let canvasEl: HTMLCanvasElement | undefined = $state(undefined);
  let chart: any = null;
  let ChartJS: any = $state(null);
  let ready = $state(false);

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
    if (browser) {
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);
      ChartJS = Chart;
      ready = true;
    }
  });

  onDestroy(() => {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  });

  function createChart() {
    if (!canvasEl || !data || !ChartJS) return;
    
    if (chart) {
      chart.destroy();
      chart = null;
    }

    const isPie = data.type === 'pie' || data.type === 'doughnut';

    const datasets = data.datasets.map((dataset, i) => ({
      ...dataset,
      backgroundColor: dataset.backgroundColor || (isPie ? colors : colors[i % colors.length]),
      borderColor: dataset.borderColor || (isPie ? borderColors : borderColors[i % borderColors.length]),
      borderWidth: 2,
      tension: data.type === 'line' ? 0.3 : undefined,
    }));

    chart = new ChartJS(canvasEl, {
      type: data.type,
      data: {
        labels: data.labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
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
            labels: {
              padding: 16,
              usePointStyle: true,
            },
          },
        },
        scales: isPie ? {} : {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
          },
          x: {
            grid: { display: false },
          },
        },
      },
    });
  }

  $effect(() => {
    if (ready && canvasEl && data && ChartJS) {
      requestAnimationFrame(() => createChart());
    }
  });
</script>

{#if ready}
<div class="chart-container">
  <canvas bind:this={canvasEl}></canvas>
</div>
{/if}

<style>
  .chart-container {
    width: 100%;
    max-width: 500px;
    margin: 1rem 0;
    padding: 1rem;
    background: white;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
</style>

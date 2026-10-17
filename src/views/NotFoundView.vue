<script setup lang="ts">
/** Экран 404. */
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const router = useRouter();
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-8">
    <div class="max-w-md text-center">
      <span
        class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800"
      >
        <AppIcon name="alert" :size="26" />
      </span>
      <h1 class="mt-4 text-lg font-semibold">Страница не найдена</h1>
      <p class="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
        Возможно, ссылка устарела. Вернитесь на главный экран и откройте документ.
      </p>
      <div class="mt-4 flex justify-center gap-2">
        <AppButton variant="primary" icon="file" @click="router.push('/')">На главную</AppButton>
        <AppButton variant="ghost" icon="cursor" @click="router.push('/editor')">
          В редактор
        </AppButton>
      </div>
    </div>
  </div>
</template>
